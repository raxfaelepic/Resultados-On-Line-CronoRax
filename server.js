const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { sincronizar, listarEventos, buscarEvento, status } = require('./src/sincronizar');

const PORTA = process.env.PORT || 3000;
const INTERVALO = Number(process.env.INTERVALO_SEGUNDOS || 60) * 1000;

const app = express();
app.use(compression());

// A página fica em public/pagina.html (só o conteúdo); aqui ela ganha o cabeçalho HTML.
const pagina = fs.readFileSync(path.join(__dirname, 'public', 'pagina.html'), 'utf8');
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>body{margin:0}[hidden]{display:none!important}</style></head><body>${pagina}</body></html>`;

app.get('/api/eventos', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(listarEventos());
});

app.get('/api/eventos/:slug', (req, res) => {
  const ev = buscarEvento(req.params.slug);
  if (!ev) return res.status(404).json({ erro: 'Evento não encontrado' });
  res.set('Cache-Control', 'public, max-age=30');
  res.json(ev);
});

app.get('/api/status', (_req, res) => res.json(status()));

app.get('*', (_req, res) => res.type('html').send(html));

app.listen(PORTA, async () => {
  console.log(`Resultados no ar na porta ${PORTA}`);
  await sincronizar();
  console.log('Primeira leitura:', status());
  setInterval(sincronizar, INTERVALO);
});
