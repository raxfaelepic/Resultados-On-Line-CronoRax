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

function processar(caminho, conteudo, chave, cfg) {
  const config = configDoArquivo(cfg, caminho);
  if (config.ocultar) { eventos.delete(caminho); return; }
  const { resumo, detalhe } = lerClax(conteudo, { arquivo: path.posix.basename(caminho), config });
  // dois arquivos com o mesmo nome de evento: o segundo ganha a data no endereço
  for (const [outro, e] of eventos) {
    if (outro !== caminho && e.resumo.slug === resumo.slug) {
      resumo.slug = detalhe.slug = `${resumo.slug}-${resumo.data || 'b'}`;
      break;
    }
  }
  resumo.pasta = detalhe.pasta = path.posix.dirname(caminho);
  eventos.set(caminho, { chave, resumo, detalhe });
}

function precisaRecarregar(caminho, chave) {
  const atual = eventos.get(caminho);
  if (!atual) return true;
  if (atual.chave !== chave) return true;
  return atual.resumo.data === hojeSaoPaulo();
}

function removerSumidos(vistos) {
  for (const caminho of [...eventos.keys()]) if (!vistos.has(caminho)) eventos.delete(caminho);
}

// ---------- modo FTP ----------
async function listarClaxFtp(cliente, pasta, nivel, saida) {
  let itens;
  try { itens = await cliente.list(pasta); } catch (e) {
    console.error(`[ftp] não consegui abrir ${pasta}:`, e.message);
    return;
  }
  for (const f of itens) {
    if (f.name === '.' || f.name === '..') continue;
    const caminho = path.posix.join(pasta, f.name);
    if (f.isFile && /\.clax$/i.test(f.name)) saida.push({ caminho, chave: `${f.size}|${f.rawModifiedAt || ''}` });
    else if (f.isDirectory && nivel < PROFUNDIDADE) await listarClaxFtp(cliente, caminho, nivel + 1, saida);
  }
}

async function sincronizarFtp(cfg) {
  const cliente = new ftp.Client(30000);
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
    await listarClaxFtp(cliente, raiz, 0, arquivos);
    const vistos = new Set();
    for (const { caminho, chave } of arquivos) {
      vistos.add(caminho);
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
    if (process.env.CLAX_PASTA) await sincronizarPasta(cfg);
    else await sincronizarFtp(cfg);
    ultimaSincronizacao = new Date().toISOString();
    ultimoErro = null;
  } catch (e) {
    ultimoErro = e.message;
    console.error('[sincronizar] falhou:', e.message);
  } finally {
    rodando = false;
  }
}

function listarEventos() {
  return [...eventos.values()].map((e) => e.resumo).sort((a, b) => b.data.localeCompare(a.data));
}

function buscarEvento(slug) {
  for (const e of eventos.values()) if (e.resumo.slug === slug) return e.detalhe;
  return null;
}

function status() {
  return {
    eventos: eventos.size,
    arquivos: [...eventos.keys()],
    ultimaSincronizacao,
    ultimoErro,
    origem: process.env.CLAX_PASTA ? 'pasta' : 'ftp',
  };
}

module.exports = { sincronizar, listarEventos, buscarEvento, status };
