// Busca os arquivos .clax (no FTP ou numa pasta local) e mantém os eventos em memória.
// Varre a pasta raiz e as subpastas (ex.: /2026/set, /2026/out, /2026/nov...),
// então um mês novo entra sozinho.
// Só baixa de novo um arquivo quando o tamanho ou a data dele mudam,
// ou quando o evento é de hoje (resultado ao vivo).

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const ftp = require('basic-ftp');
const { lerClax } = require('./clax');

const PROFUNDIDADE = Number(process.env.PROFUNDIDADE || 3); // quantos níveis de subpasta olhar

const eventos = new Map();      // caminho do arquivo -> { chave, resumo, detalhe }
let ultimaSincronizacao = null;
let ultimoErro = null;
let rodando = false;

function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eventos.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

// procura a configuração pelo caminho completo ("/2026/out/EVENTO.clax") ou só pelo nome ("EVENTO.clax")
function configDoArquivo(cfg, caminho) {
  const geral = cfg.padrao || {};
  const lista = cfg.eventos || {};
  const doEvento = lista[caminho] || lista[path.posix.basename(caminho)] || {};
  return { ...geral, ...doEvento };
}

function hojeSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}

// Arquivos que nunca entram na página (backups, cópias, testes).
// Dá pra trocar a lista no eventos.json, em "padrao": { "ignorarArquivos": [...] }
const IGNORAR_PADRAO = ['backup', 'bkp', 'old', 'teste', 'test', 'copia', 'cópia', 'simulado'];

function deveIgnorar(cfg, caminho, nomeEvento) {
  const termos = ((cfg.padrao && cfg.padrao.ignorarArquivos) || IGNORAR_PADRAO).map((t) => t.toLowerCase());
  const lista = cfg.eventos || {};
  if (lista[caminho] || lista[path.posix.basename(caminho)]) return false; // cadastrado no eventos.json: sempre entra
  const alvo = `${caminho} ${nomeEvento || ''}`.toLowerCase();
  return termos.some((t) => new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(alvo));
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function dataPelaPasta(caminho) {
  const m = /\/(20\d\d)\/([a-zç]{3})/i.exec(caminho);
  if (!m) return '';
  const i = MESES.indexOf(m[2].toLowerCase().slice(0, 3));
  return i < 0 ? '' : `${m[1]}-${String(i + 1).padStart(2, '0')}-01`;
}

function processar(caminho, conteudo, chave, cfg) {
  const config = configDoArquivo(cfg, caminho);
  if (config.ocultar) { eventos.set(caminho, { chave, oculto: 'ocultado no eventos.json' }); return; }
  if (deveIgnorar(cfg, caminho)) { eventos.set(caminho, { chave, oculto: 'backup/teste' }); return; }
  const { resumo, detalhe } = lerClax(conteudo, { arquivo: path.posix.basename(caminho), config });
  if (!resumo.data) resumo.data = detalhe.data = dataPelaPasta(caminho);
  resumo.pasta = detalhe.pasta = path.posix.dirname(caminho);
  const oculto = deveIgnorar(cfg, caminho, resumo.nome) ? 'backup/teste'
    : !resumo.inscritos ? 'sem atletas' : !resumo.percursos.length ? 'sem percurso' : false;
  // o detalhe fica guardado já em texto (JSON), que ocupa bem menos memória
  eventos.set(caminho, { chave, resumo, detalhe: oculto ? null : JSON.stringify(detalhe), oculto });
}

// Monta a lista pública: some com os ocultos e, quando o mesmo evento aparece em
// mais de um arquivo (reexportações), fica só o salvo por último no Wiclax.
let publicos = [];
let porSlug = new Map();
function montarIndice() {
  const melhores = new Map(); // slug + data -> item
  for (const item of eventos.values()) {
    if (item.oculto) continue;
    const k = `${item.resumo.slugBase || item.resumo.slug}|${item.resumo.data}`;
    const atual = melhores.get(k);
    if (!atual || (item.resumo.atualizado || '') > (atual.resumo.atualizado || '')) melhores.set(k, item);
  }
  const lista = [...melhores.values()].sort((a, b) => b.resumo.data.localeCompare(a.resumo.data));
  porSlug = new Map();
  for (const item of lista) {
    const base = item.resumo.slugBase || item.resumo.slug;
    item.resumo.slugBase = base;
    let slug = base;
    if (porSlug.has(slug)) slug = `${base}-${item.resumo.data || 'b'}`;
    let n = 2;
    while (porSlug.has(slug)) slug = `${base}-${n++}`;
    item.resumo.slug = slug;
    porSlug.set(slug, item);
  }
  publicos = lista.map((i) => i.resumo);
}

function precisaRecarregar(caminho, chave) {
  const atual = eventos.get(caminho);
  if (!atual) return true;
  if (atual.chave !== chave) return true;
  return !!atual.resumo && atual.resumo.data === hojeSaoPaulo();
}

function removerSumidos(vistos) {
  for (const caminho of [...eventos.keys()]) if (!vistos.has(caminho)) eventos.delete(caminho);
}

// ---------- modo FTP ----------
let diagnostico = {};
async function listarClaxFtp(cliente, pasta, nivel, saida) {
  let itens;
  try {
    // entra na pasta e lista "ela mesma" (alguns servidores erram ao listar passando o caminho)
    await cliente.cd(pasta);
    itens = await cliente.list();
  } catch (e) {
    console.error(`[ftp] não consegui abrir ${pasta}:`, e.message);
    if (nivel === 0) throw new Error(`Não consegui abrir a pasta "${pasta}" no FTP: ${e.message}`);
    diagnostico.errosEmSubpastas = (diagnostico.errosEmSubpastas || 0) + 1;
    return;
  }
  diagnostico.pastasVisitadas = (diagnostico.pastasVisitadas || 0) + 1;
  if (nivel === 0) {
    diagnostico.conteudoDaPasta = itens.slice(0, 40).map((f) => (f.isDirectory ? `[pasta] ${f.name}` : f.name));
    if (itens.length > 40) diagnostico.conteudoDaPasta.push(`... e mais ${itens.length - 40} itens`);
  }
  for (const f of itens) {
    if (f.name === '.' || f.name === '..') continue;
    const caminho = path.posix.join(pasta, f.name);
    if (f.isFile && /\.clax$/i.test(f.name)) saida.push({ caminho, chave: `${f.size}|${f.rawModifiedAt || ''}` });
    else if (f.isDirectory && nivel < PROFUNDIDADE) await listarClaxFtp(cliente, caminho, nivel + 1, saida);
  }
}

let clienteAtual = null;
async function sincronizarFtp(cfg) {
  const cliente = new ftp.Client(30000);
  clienteAtual = cliente;
  const raiz = process.env.FTP_PASTA || '/';
  try {
    await cliente.access({
      host: process.env.FTP_HOST,
      port: Number(process.env.FTP_PORTA || 21),
      user: process.env.FTP_USUARIO,
      password: process.env.FTP_SENHA,
      secure: process.env.FTP_SEGURO === 'sim',
    });
    const arquivos = [];
    diagnostico = { pastaConfigurada: raiz };
    try { diagnostico.pastaInicialDoUsuario = await cliente.pwd(); } catch (e) { diagnostico.pastaInicialDoUsuario = `erro: ${e.message}`; }
    // não usar "LIST -a": vários servidores entendem o "-a" como nome de pasta e devolvem lista vazia
    cliente.availableListCommands = cliente.availableListCommands.filter((c) => c !== 'LIST -a');
    if (!cliente.availableListCommands.length) cliente.availableListCommands = ['LIST'];
    diagnostico.comandoDeListagem = cliente.availableListCommands.join(' / ');
    // guarda a resposta crua da primeira listagem, para diagnóstico
    const parseOriginal = cliente.parseList;
    cliente.parseList = (texto) => {
      if (diagnostico.respostaCrua === undefined) diagnostico.respostaCrua = String(texto).slice(0, 1200);
      return parseOriginal(texto);
    };
    await listarClaxFtp(cliente, raiz, 0, arquivos);
    const vistos = new Set();
    for (const { caminho, chave } of arquivos) {
      vistos.add(caminho);
      if (deveIgnorar(cfg, caminho)) { eventos.set(caminho, { chave, oculto: 'backup/teste' }); continue; }
      if (!precisaRecarregar(caminho, chave)) continue;
      const pedacos = [];
      const destino = new Writable({ write(c, _e, cb) { pedacos.push(c); cb(); } });
      try {
        await cliente.downloadTo(destino, caminho);
        processar(caminho, Buffer.concat(pedacos).toString('utf8'), chave, cfg);
      } catch (e) {
        console.error(`[clax] erro lendo ${caminho}:`, e.message);
      }
    }
    removerSumidos(vistos);
  } finally {
    cliente.close();
  }
}

// ---------- modo pasta local (para testes) ----------
function listarClaxPasta(base, relativo, nivel, saida) {
  for (const nome of fs.readdirSync(path.join(base, relativo))) {
    const rel = path.posix.join(relativo, nome);
    const st = fs.statSync(path.join(base, rel));
    if (st.isFile() && /\.clax$/i.test(nome)) saida.push({ caminho: rel, chave: `${st.size}|${st.mtimeMs}` });
    else if (st.isDirectory() && nivel < PROFUNDIDADE) listarClaxPasta(base, rel, nivel + 1, saida);
  }
}

async function sincronizarPasta(cfg) {
  const base = process.env.CLAX_PASTA;
  const arquivos = [];
  listarClaxPasta(base, '/', 0, arquivos);
  const vistos = new Set();
  for (const { caminho, chave } of arquivos) {
    vistos.add(caminho);
    if (deveIgnorar(cfg, caminho)) { eventos.set(caminho, { chave, oculto: 'backup/teste' }); continue; }
    if (!precisaRecarregar(caminho, chave)) continue;
    try {
      processar(caminho, fs.readFileSync(path.join(base, caminho), 'utf8'), chave, cfg);
    } catch (e) {
      console.error(`[clax] erro lendo ${caminho}:`, e.message);
    }
  }
  removerSumidos(vistos);
}

async function sincronizar() {
  if (rodando) return;
  rodando = true;
  const cfg = lerConfig();
  try {
    // se uma leitura travar (FTP sem responder), desiste depois de alguns minutos
    const limiteMs = Number(process.env.TEMPO_MAXIMO_SEGUNDOS || 300) * 1000;
    let timer;
    const tempoEsgotado = new Promise((_, rejeitar) => {
      timer = setTimeout(() => {
        try { if (clienteAtual) clienteAtual.close(); } catch (e) { /* ignora */ }
        rejeitar(new Error('Leitura do FTP demorou demais e foi cancelada; tenta de novo na próxima rodada'));
      }, limiteMs);
    });
    const trabalho = process.env.CLAX_PASTA ? sincronizarPasta(cfg) : sincronizarFtp(cfg);
    try { await Promise.race([trabalho, tempoEsgotado]); } finally { clearTimeout(timer); }
    montarIndice();
    ultimaSincronizacao = new Date().toISOString();
    ultimoErro = null;
  } catch (e) {
    ultimoErro = `${new Date().toISOString()} ${e.message}`;
    montarIndice(); // mantém no ar o que já foi lido
    console.error('[sincronizar] falhou:', e.message);
  } finally {
    rodando = false;
  }
}

function listarEventos() {
  return publicos;
}

// devolve o JSON do evento já em texto (ou null)
function buscarEvento(slug) {
  const item = porSlug.get(slug);
  if (!item) return null;
  // o slug pode ter ganhado sufixo; ajusta no texto guardado
  return item.detalhe.replace(/"slug":"[^"]*"/, `"slug":${JSON.stringify(slug)}`);
}

function status() {
  const todos = [...eventos.entries()];
  return {
    eventosNaPagina: publicos.length,
    arquivosLidos: todos.length,
    arquivosOcultos: Object.fromEntries(todos.filter(([, e]) => e.oculto).map(([c, e]) => [c, e.oculto])),
    repetidosAgrupados: todos.filter(([, e]) => !e.oculto).length - publicos.length,
    ultimaSincronizacao,
    ultimoErro,
    ftp: diagnostico,
    origem: process.env.CLAX_PASTA ? 'pasta' : 'ftp',
  };
}

module.exports = { sincronizar, listarEventos, buscarEvento, status };
