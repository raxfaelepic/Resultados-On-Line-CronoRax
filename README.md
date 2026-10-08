# Resultados Wiclax

Página de resultados que lê sozinha os arquivos `.clax` do Wiclax que estão no FTP.
Cada `.clax` no FTP vira um evento na lista. Subiu um arquivo novo, o evento aparece.
O servidor olha a pasta raiz e as subpastas (ex.: `/2026/set`, `/2026/out`, `/2026/nov`), então cada mês novo entra sozinho.
No dia da prova, a página recarrega os resultados a cada minuto.

## Como colocar no ar (Railway)

1. Suba esta pasta para um repositório no GitHub (sem a pasta `node_modules` e sem a pasta `clax`).
2. No Railway: **New Project → Deploy from GitHub repo** e escolha o repositório.
3. Em **Variables**, cadastre:

| Variável | O que é | Exemplo |
|---|---|---|
| `FTP_HOST` | endereço do FTP | `ftp.seudominio.com.br` |
| `FTP_USUARIO` | usuário do FTP | `wiclax` |
| `FTP_SENHA` | senha do FTP | |
| `FTP_PASTA` | pasta raiz; o servidor olha ela e as subpastas (ano/mês) | `/` ou `/2026` |
| `FTP_PORTA` | opcional, padrão 21 | `21` |
| `FTP_SEGURO` | `sim` se o FTP usar FTPS | |
| `INTERVALO_SEGUNDOS` | de quanto em quanto tempo olha o FTP (padrão 60) | `60` |

4. Em **Settings → Networking**, gere o domínio. Pronto.

Para conferir se está lendo o FTP, abra `/api/status` no endereço do site.

## Dados extras de cada evento (`eventos.json`)

O `.clax` traz nome, data e percursos, mas não traz cidade. Isso fica no `eventos.json`,
usando o **nome do arquivo** como chave (ou o caminho completo, ex.: `/2026/out/EVENTO.clax`, se tiver dois arquivos com o mesmo nome em meses diferentes):

```json
{
  "padrao": { "ocultarPercursos": ["EM ANALISE"] },
  "eventos": {
    "MEU_EVENTO.clax": {
      "nome": "Nome bonito do evento",
      "cidade": "Ribeirão Preto · SP",
      "tipo": "Trail run",
      "ocultar": false
    }
  }
}
```

- `ocultar: true` tira o evento da página (bom para provas de teste).
- `ocultarPercursos` esconde percursos como "EM ANALISE".
- `km` permite corrigir a distância de um percurso, se o nome não tiver o número: `"km": { "Desafio": 7.5 }`.

Se o evento não estiver no `eventos.json`, ele aparece mesmo assim, só sem a cidade.

## Privacidade

O leitor (`src/clax.js`) copia só nome, peito, sexo, categoria, percurso, equipe e tempos.
CPF, telefone, e-mail e ano de nascimento que existem no `.clax` **nunca** vão para a página.

## Testar no computador

Coloque arquivos `.clax` na pasta `clax/` e rode:

```
npm install
CLAX_PASTA=./clax npm start
```

Abra http://localhost:3000
