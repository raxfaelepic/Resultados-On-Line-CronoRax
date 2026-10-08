// Lê um arquivo .clax (XML do Wiclax) e devolve o evento pronto para a página.
// IMPORTANTE: só copia campos públicos. CPF, telefone e e-mail (InfoPerso ip0/ip1/ip2)
// e ano de nascimento NUNCA saem daqui.

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (nome) => ['Etape', 'E', 'R', 'C', 'G', 'Pcs'].includes(nome),
});

// "00h16'13" ou "07h06'06,048" -> segundos (ignora fração)
function tempoEmSegundos(txt) {
  const m = /^(\d+)h(\d+)'(\d+)/.exec(txt || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// "10 KM", "5 KM PCD", "21,1K" -> 10 / 5 / 21.1
function kmDoNome(nome) {
  const m = /(\d+(?:[.,]\d+)?)\s*K/i.exec(nome || '');
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

function slugify(txt) {
  return String(txt)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Data do evento: usa dt1 ("2026-09-13"); se estiver vazio, usa o número de dias do
// campo "date" (mesmo formato do Excel, ex.: 46278 = 13/09/2026)
function dataDoEvento(raiz) {
  if (/^\d{4}-\d{2}-\d{2}/.test(raiz.dt1 || '')) return raiz.dt1.slice(0, 10);
  const dias = parseFloat(String(raiz.date || '').replace(',', '.'));
  if (dias > 30000 && dias < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(dias) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return '';
}

/**
 * @param {string} xml      conteúdo do .clax
 * @param {object} opcoes   { arquivo, config }  config = dados extras do eventos.json
 */
function lerClax(xml, { arquivo = '', config = {} } = {}) {
  const raiz = parser.parse(xml).Epreuve;
  if (!raiz) throw new Error('Arquivo não parece um .clax do Wiclax (sem <Epreuve>)');

  // etapa ativa; se ela não tiver inscritos, usa a primeira que tiver
  const etapas = (raiz.Etapes && raiz.Etapes.Etape) || [];
  const temInscritos = (et) => et && et.Engages && et.Engages.E && et.Engages.E.length;
  let etapa = etapas[Number(raiz.etapeActive || 1) - 1];
  if (!temInscritos(etapa)) etapa = etapas.find(temInscritos) || etapas[0] || {};
  if (!temInscritos(etapa) && raiz.Engages) etapa = { ...etapa, Engages: raiz.Engages, Resultats: etapa.Resultats || raiz.Resultats };
  const ocultarPercursos = new Set((config.ocultarPercursos || []).map((p) => p.toUpperCase()));

  // percursos: lista do Wiclax; se vier vazia ou incompleta, completa com os percursos dos próprios atletas
  const nomesPercurso = [];
  const jaTem = new Set();
  const addPercurso = (n) => {
    const nome = limpa(n);
    if (!nome || jaTem.has(nome.toUpperCase()) || ocultarPercursos.has(nome.toUpperCase())) return;
    jaTem.add(nome.toUpperCase()); nomesPercurso.push(nome);
  };
  ((raiz.Parcours && raiz.Parcours.Pcs) || []).forEach((p) => addPercurso(p.nom));
  const extras = [];
  for (const e of (etapa.Engages && etapa.Engages.E) || []) {
    const n = limpa(e.p);
    if (n && !jaTem.has(n.toUpperCase()) && !extras.includes(n)) extras.push(n);
  }
  extras.sort((a, b) => (kmDoNome(a) || 999) - (kmDoNome(b) || 999) || a.localeCompare(b)).forEach(addPercurso);
  const percursos = nomesPercurso.map((nome) => ({ nome, km: (config.km && config.km[nome]) || kmDoNome(nome) }));
  const percursoPorChave = new Map(percursos.map((p) => [p.nome.toUpperCase(), p.nome]));

  // categorias: abreviação -> nome
  const categorias = {};
  const ordemCat = [];
  const faixas = []; // faixas etárias: { abr, sexo, min, max }
  for (const g of (raiz.Categories && raiz.Categories.G) || []) {
    for (const c of g.C || []) {
      if (c.abr && !categorias[c.abr]) { categorias[c.abr] = limpa(c.nom) || c.abr; ordemCat.push(c.abr); }
      const min = Number(c.agemin), max = Number(c.agemax);
      if (c.abr && max > 0 && (c.sx === '1' || c.sx === '2')) faixas.push({ abr: c.abr, sexo: c.sx === '1' ? 'M' : 'F', min, max });
    }
  }
  // categorias do geral: as do Wiclax que tiverem GERAL/GRL no nome; se não houver, cria
  const geralDe = { M: '', F: '' };
  for (const abr of ordemCat) {
    if (!/GRL|GERAL/i.test(`${abr} ${categorias[abr]}`)) continue;
    const txt = `${abr} ${categorias[abr]}`.toUpperCase();
    if (!geralDe.F && /(^F|FEM)/.test(txt)) geralDe.F = abr;
    else if (!geralDe.M && /(^M|MASC)/.test(txt)) geralDe.M = abr;
  }
  if (!geralDe.M) { geralDe.M = 'MGRL'; categorias.MGRL = 'Masculino Geral'; ordemCat.unshift('MGRL'); }
  if (!geralDe.F) { geralDe.F = 'FGRL'; categorias.FGRL = 'Feminino Geral'; ordemCat.unshift('FGRL'); }
  const ehCatGeral = (abr) => abr && (abr === geralDe.M || abr === geralDe.F);

  // inscritos (só campos públicos)
  const atletas = new Map();
  for (const e of (etapa.Engages && etapa.Engages.E) || []) {
    const nome = limpa(e.n);
    const percurso = percursoPorChave.get(limpa(e.p).toUpperCase());
    if (!e.d || !nome || nome.startsWith('*****')) continue;   // "ATLETA DESCONHECIDO"
    if (!percurso) continue;                                   // sem percurso ou percurso oculto
    atletas.set(String(e.d), {
      d: Number(e.d),
      n: nome,
      x: e.x === 'F' ? 'F' : e.x === 'M' ? 'M' : '',
      ca: e.ca || '',
      p: percurso,
      c: limpa(e.c),
      t: null,     // tempo líquido (chip), em segundos
      tb: null,    // tempo bruto (desde a largada do percurso)
      st: 'ns',    // ns = sem resultado, ok = concluiu, dsq = desclassificado
      _ano: Number(e.a) || 0, // ano de nascimento: só para calcular a faixa etária, não vai para a página
    });
  }

  // resultados
  for (const r of (etapa.Resultats && etapa.Resultats.R) || []) {
    const a = atletas.get(String(r.d));
    if (!a) continue;
    const t = tempoEmSegundos(r.t);
    if (t != null) {
      a.t = t;
      a.tb = tempoEmSegundos(r.re);
      a.st = 'ok';
    } else if (/desq|dsq/i.test(r.t || '') || r.tr === '5') {
      a.st = 'dsq';
    }
  }

  // Classificações por percurso, pela regra da federação:
  //   geral e por sexo -> tempo bruto (desde a largada do percurso)
  //   os 5 primeiros de cada sexo vão para a categoria GERAL e saem da faixa etária
  //   faixa etária     -> tempo líquido (chip)
  // No eventos.json dá pra mudar: "classificacaoGeral": "liquido" e "podioGeral": 3
  const geralPorBruto = (config.classificacaoGeral || 'bruto') !== 'liquido';
  const podioGeral = Number(config.podioGeral || 5);
  const bruto = (a) => (geralPorBruto && a.tb != null ? a.tb : a.t);
  const anoProva = Number((dataDoEvento(raiz) || '').slice(0, 4)) || new Date().getFullYear();
  const faixaEtaria = (a) => {
    if (!a._ano) return '';
    const idade = anoProva - a._ano;
    const f = faixas.find((x) => x.sexo === a.x && idade >= x.min && idade <= x.max);
    return f ? f.abr : '';
  };
  const lista = [...atletas.values()];
  for (const { nome } of percursos) {
    const chegaram = lista.filter((a) => a.p === nome && a.st === 'ok');
    const porSexo = {};
    [...chegaram].sort((a, b) => bruto(a) - bruto(b) || a.t - b.t || a.d - b.d).forEach((a, i) => {
      a.pos = i + 1;
      porSexo[a.x] = (porSexo[a.x] || 0) + 1; a.sp = porSexo[a.x];
      if (a.x && a.sp <= podioGeral) a.ca = geralDe[a.x];                // top 5 -> geral
      else if (!a.ca || ehCatGeral(a.ca)) a.ca = faixaEtaria(a) || a.ca; // volta para a faixa etária
      if (a.x && a.sp > podioGeral && ehCatGeral(a.ca)) a.ca = '';       // sem ano de nascimento: fica sem categoria
    });
    const porCat = {};
    for (const a of chegaram) if (a.ca) (porCat[a.ca] = porCat[a.ca] || []).push(a);
    for (const [abr, grupo] of Object.entries(porCat)) {
      const tempo = ehCatGeral(abr) ? bruto : (a) => a.t;
      grupo.sort((a, b) => tempo(a) - tempo(b) || a.d - b.d).forEach((a, i) => { a.cp = i + 1; });
    }
  }
  // quem não terminou e está como GERAL no Wiclax volta para a faixa etária
  for (const a of lista) {
    if (a.st !== 'ok' && ehCatGeral(a.ca)) a.ca = faixaEtaria(a);
    delete a._ano;
  }
  const nome = limpa(raiz.nom) || arquivo.replace(/\.clax$/i, '');
  const data = dataDoEvento(raiz);
  const resumo = {
    slug: config.slug || slugify(nome),
    nome: config.nome || nome,
    data: config.data || data,
    cidade: config.cidade || '',
    tipo: config.tipo || 'Corrida de rua',
    organizador: limpa(raiz.organisateur),
    percursos,
    inscritos: lista.length,
    concluintes: lista.filter((a) => a.st === 'ok').length,
    geralPor: geralPorBruto ? 'bruto' : 'liquido',
    podioGeral,
    atualizado: raiz.derSvg || '',
    arquivo,
  };

  return {
    resumo,
    detalhe: {
      ...resumo,
      categorias,
      ordemCategorias: ordemCat.filter((c) => lista.some((a) => a.ca === c)),
      atletas: lista,
    },
  };
}

module.exports = { lerClax, tempoEmSegundos, kmDoNome, slugify };
