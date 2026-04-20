# MCP SQL Server

Servidor MCP (Model Context Protocol) para Microsoft SQL Server.
Permite que Claude Code, Codex, Cursor, Windsurf, Cline, Continue e outras ferramentas MCP explorem schema, relacionamentos e executem consultas SQL com foco em seguranca.

## O que ele faz

- Explora schemas, tabelas, colunas, indices, procedures e foreign keys
- Monta ranking por intencao com `find_entities`
- Sugere caminhos de join com `suggest_join_path`
- Gera plano de consulta com `plan_query`
- Valida SQL antes de executar com `validate_query`
- Executa `SELECT` e, opcionalmente, escrita controlada por permissoes
- Mantem catalogo em memoria com cache e refresh
- Permite trocar o banco ativo em runtime com `switch_database`
- Permite trocar a porta ativa em runtime com `switch_port`
- Permite trocar porta, usuario, senha e banco em uma unica acao com `switch_connection`
- Lista bancos acessiveis no servidor com `list_databases`
- Mostra a conexao ativa com `current_connection`
- Retorna respostas em formato visual com box-drawing ASCII/Unicode durante a execucao das tools

## Ferramentas disponiveis

| Ferramenta | Descricao |
|------------|-----------|
| `current_connection` | Mostra servidor, porta, banco ativo, permissao e cache |
| `list_databases` | Lista bancos acessiveis no SQL Server atual |
| `list_schemas` | Lista todos os schemas do banco |
| `list_tables` | Lista tabelas e views agrupadas por schema |
| `find_tables` | Busca tabelas e views por nome |
| `describe_table` | Mostra colunas, PK, FK, checks, identity e computed |
| `list_indexes` | Lista indices, key columns e included columns |
| `table_stats` | Mostra rows, tamanho e datas da tabela |
| `find_columns` | Busca colunas por nome em todas as tabelas |
| `relationship_map` | Mostra o mapa de relacionamentos de um schema |
| `list_procedures` | Lista procedures e functions |
| `query` | Executa SQL respeitando as regras de permissao |
| `permissions` | Mostra o modo atual e operacoes permitidas/bloqueadas |
| `sample_values` | Retorna amostras distintas de valores por coluna |
| `query_with_explanation` | Executa query de leitura e adiciona interpretacao curta |
| `switch_database` | Troca o banco ativo da sessao atual sem reiniciar o MCP |
| `switch_port` | Troca a porta SQL Server da sessao atual sem reiniciar o MCP |
| `switch_connection` | Troca porta, usuario, senha e banco juntos com uma unica reconexao |
| `refresh_metadata` | Recarrega o catalogo em cache |
| `health` | Mostra estado da conexao e metricas do cache |
| `find_entities` | Busca entidades por linguagem natural |
| `schema_summary` | Resume schemas e tabelas mais conectadas |
| `explain_table` | Explica o papel provavel de uma tabela |
| `suggest_join_path` | Sugere joins a partir do grafo de FKs |
| `plan_query` | Gera um plano de consulta a partir de um objetivo |
| `validate_query` | Analisa SQL antes da execucao |

## Sobre este README

Este arquivo fica em Markdown normal para leitura no GitHub e nas IDEs.
O visual com box-drawing ASCII/Unicode aparece apenas na execucao das tools do MCP, nas respostas retornadas para Claude, Codex, Cursor e clientes compativeis.

## Requisitos

- Node.js 18 ou superior
- Acesso a um SQL Server local ou remoto

## Instalacao

```bash
git clone https://github.com/WendellOttoni/mcp-sqlserver.git
cd mcp-sqlserver
npm install
```

## Configuracao MCP

Exemplo de `.mcp.json`:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["C:/MCP/mcp-sqlserver/src/index.js"],
      "env": {
        "DB_SERVER": "localhost",
        "DB_DATABASE": "MeuBanco",
        "DB_USER": "sa",
        "DB_PASSWORD": "MinhaSenha"
      }
    }
  }
}
```

Voce tambem pode usar o template em `.mcp.json.example`.

## Variaveis de ambiente

| Variavel | Obrigatoria | Padrao | Descricao |
|----------|-------------|--------|-----------|
| `DB_SERVER` | Nao | `localhost` | Host do SQL Server |
| `DB_DATABASE` | Sim | - | Banco inicial da sessao |
| `DB_USER` | Nao | - | Usuario SQL; se omitido usa Windows Auth |
| `DB_PASSWORD` | Nao | - | Senha SQL |
| `DB_PORT` | Nao | `1433` | Porta do SQL Server; ignorada em instancia nomeada |
| `DB_ENCRYPT` | Nao | `false` | Habilita criptografia na conexao com SQL Server |
| `DB_TRUST_SERVER_CERTIFICATE` | Nao | `true` | Confia no certificado do servidor sem validacao completa |
| `DB_ALLOW_WRITE` | Nao | - | Operacoes de escrita permitidas |
| `DB_ALLOW_TABLES` | Nao | - | Restringe escrita a tabelas especificas |
| `DB_ALLOW_SCHEMAS` | Nao | - | Restringe escrita a schemas especificos |
| `DB_ALLOW_DATABASE_SWITCH` | Nao | - | Allowlist opcional de bancos permitidos para `switch_database` |
| `DB_METADATA_TTL_MS` | Nao | `300000` | TTL do cache de metadata em ms |
| `DB_QUERY_TIMEOUT_MS` | Nao | `30000` | Timeout das queries em ms |
| `DB_DEFAULT_MAX_ROWS` | Nao | `100` | Limite padrao de linhas para leitura |
| `DB_SAMPLE_SIZE` | Nao | `5` | Quantidade padrao do `sample_values` |

## Formatos de `DB_SERVER`

| Formato | Exemplo |
|---------|---------|
| Host local | `localhost` |
| IP | `192.168.1.100` |
| Nome da maquina | `SERVIDOR-SQL` |
| Instancia nomeada com `\\` | `LAPTOP-ABC\\SQLEXPRESS` |
| Instancia nomeada com `/` | `LAPTOP-ABC/SQLEXPRESS` |

Se usar `/`, o MCP converte automaticamente para o formato de instancia nomeada.

## Modo de permissao

Por padrao o servidor sobe em modo `READ-ONLY`.
Sem `DB_ALLOW_WRITE`, apenas consultas de leitura sao permitidas.

Exemplo:

```json
{
  "DB_ALLOW_WRITE": "INSERT,UPDATE",
  "DB_ALLOW_TABLES": "dbo.Produto,dbo.Pedido"
}
```

Operacoes permanentemente bloqueadas:

`EXEC`, `EXECUTE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `DBCC`, `BULK`, `OPENROWSET`, `OPENDATASOURCE`, `xp_*`, `sp_*`

## Troca de banco em runtime

Agora nao e mais necessario reiniciar o processo MCP para apontar para outro banco no mesmo servidor.

Fluxo recomendado:

1. Rode `current_connection` para confirmar onde a sessao esta conectada.
2. Rode `list_databases` para ver os bancos acessiveis.
3. Rode `switch_database` para trocar o banco ativo.
4. Rode `schema_summary` ou `list_schemas` para explorar o novo banco.

Use:

```text
switch_database { "database": "OutroBanco" }
```

Comportamento:

- valida a nova conexao antes de trocar
- carrega o catalogo do novo banco antes de assumir a sessao
- fecha o pool antigo apenas depois da validacao
- se a troca falhar, a conexao atual continua ativa

Observacao:

- `switch_database` troca apenas o banco ativo
- `server`, `user`, `password` e outras configuracoes permanecem as mesmas
- `list_databases` oculta `master`, `model`, `msdb` e `tempdb` por padrao
- use `include_system_databases: true` para incluir bancos de sistema

Para limitar quais bancos podem ser usados em `switch_database`, configure:

```json
{
  "DB_ALLOW_DATABASE_SWITCH": "ReqPlay,Homologacao,Teste"
}
```

Se `DB_ALLOW_DATABASE_SWITCH` nao for definida, qualquer banco acessivel pelo login atual pode ser usado.

## Troca de porta em runtime

Use `switch_port` para apontar a sessao atual para outra porta TCP do mesmo servidor sem reiniciar o chat ou perder o contexto da IA.

Fluxo recomendado:

1. Rode `current_connection` para ver servidor, porta e banco atuais.
2. Rode `switch_port` com a nova porta.
3. Rode `current_connection`, `schema_summary` ou `list_schemas` para confirmar a nova conexao.

Use:

```text
switch_port { "port": 1450 }
```

Comportamento:

- valida a nova conexao antes de trocar
- carrega o catalogo usando a nova porta antes de assumir a sessao
- fecha o pool antigo apenas depois da validacao
- se a troca falhar, a conexao atual continua ativa

Observacao:

- `switch_port` troca apenas a porta
- `server`, `database`, `user`, `password` e outras configuracoes permanecem as mesmas
- em `DB_SERVER` com instancia nomeada, a porta e gerenciada pela instancia e `switch_port` nao e aplicado

## Troca completa de conexao em runtime

Use `switch_connection` quando precisar trocar porta, usuario, senha e banco de uma vez so, com apenas uma validacao e uma reconexao ao final.

Use:

```text
switch_connection {
  "port": 51218,
  "user": "sa",
  "password": "Docker@Test123",
  "database": "master"
}
```

Comportamento:

- todos os parametros sao opcionais
- qualquer campo omitido mantem o valor atual
- a troca so e assumida depois que a nova conexao completa for validada
- o pool antigo so e fechado no final, apos validar e carregar o catalogo

## Exemplos de configuracao

Somente leitura:

```json
{
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco"
}
```

SQL Auth:

```json
{
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaSenha"
}
```

Instancia nomeada:

```json
{
  "DB_SERVER": "LAPTOP-ABC/SQLEXPRESS",
  "DB_DATABASE": "MeuBanco"
}
```

Escrita restrita por tabela:

```json
{
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_ALLOW_WRITE": "INSERT,UPDATE",
  "DB_ALLOW_TABLES": "dbo.Produto,dbo.Pedido"
}
```

Escrita restrita por schema:

```json
{
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_ALLOW_WRITE": "INSERT,UPDATE,DELETE",
  "DB_ALLOW_SCHEMAS": "staging"
}
```

Servidor remoto com porta customizada:

```json
{
  "DB_SERVER": "192.168.1.100",
  "DB_PORT": "1450",
  "DB_DATABASE": "Producao",
  "DB_USER": "app_user",
  "DB_PASSWORD": "SenhaSegura"
}
```

Servidor remoto com TLS validado:

```json
{
  "DB_SERVER": "sql.empresa.local",
  "DB_PORT": "1433",
  "DB_DATABASE": "Producao",
  "DB_USER": "app_user",
  "DB_PASSWORD": "SenhaSegura",
  "DB_ENCRYPT": "true",
  "DB_TRUST_SERVER_CERTIFICATE": "false"
}
```

## Ferramentas de analise

As ferramentas abaixo usam metadata carregada em memoria para responder mais rapido:

- `find_entities`
- `schema_summary`
- `explain_table`
- `suggest_join_path`
- `plan_query`
- `refresh_metadata`
- `health`

## Seguranca

- `READ-ONLY` por padrao
- Escrita controlada por operacao, schema e tabela
- Validacao de SQL antes da execucao
- Limite maximo de 1000 linhas no fluxo de leitura
- Cache de metadata com TTL configuravel
- Validacao de conexao logo no startup
- Troca de banco em runtime com validacao antes do cutover

## Estrutura do projeto

```text
mcp-sqlserver/
|-- .mcp.json.example
|-- README.md
|-- package.json
|-- src/
|   |-- config/
|   |   `-- env.js
|   |-- db/
|   |   |-- catalog-cache.js
|   |   |-- catalog-loader.js
|   |   `-- connection.js
|   |-- graph/
|   |   `-- relationship-graph.js
|   |-- search/
|   |   |-- aliases.js
|   |   `-- ranker.js
|   |-- security/
|   |   |-- permissions.js
|   |   `-- sql-validator.js
|   |-- tools/
|   |   |-- core.js
|   |   `-- intelligence.js
|   |-- utils/
|   |   |-- formatting.js
|   |   `-- text.js
|   `-- index.js
`-- test/
    |-- sample-values.test.js
    `-- security.test.js
```

## Desenvolvimento

Executar o servidor:

```bash
npm start
```

Rodar os testes:

```bash
npm test
```
