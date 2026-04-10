# MCP SQL Server

Servidor MCP (Model Context Protocol) para **Microsoft SQL Server**.
Permite que ferramentas de IA explorem e consultem bancos SQL Server diretamente durante a conversa.

Compativel com **Claude Code**, **Cursor**, **Windsurf**, **Codex**, **Cline**, **Continue** e qualquer ferramenta que suporte MCP.

---

## Ferramentas disponíveis

| Ferramenta | Descricao |
|------------|-----------|
| `list_schemas` | Lista todos os schemas do banco |
| `list_tables` | Lista tabelas e views, agrupadas por schema |
| `find_tables` | Busca tabelas e views por nome (parcial) |
| `describe_table` | Colunas, tipos, PKs, FKs, constraints e flags (IDENTITY, COMPUTED) |
| `list_indexes` | Indexes de uma tabela com colunas-chave e included columns |
| `table_stats` | Contagem de linhas, tamanho em disco e datas da tabela |
| `find_columns` | Busca colunas por nome em todas as tabelas |
| `relationship_map` | Mapa visual de todas as FKs de um schema |
| `list_procedures` | Lista stored procedures e functions |
| `query` | Executa queries SQL (escrita controlada por DB_ALLOW_WRITE) |
| `sample_values` | Coleta amostras distintas de valores por coluna |
| `query_with_explanation` | Executa SELECT e devolve um resumo interpretado |
| `permissions` | Mostra o modo atual e todas as permissoes configuradas |
| `refresh_metadata` | Recarrega o catalogo em cache |
| `health` | Mostra estado da conexao e metricas do cache |
| `find_entities` | Busca tabelas por intencao usando nomes, colunas, descricoes e aliases |
| `schema_summary` | Resume schemas e destaca tabelas mais centrais |
| `explain_table` | Explica o papel provavel de uma tabela |
| `suggest_join_path` | Encontra caminho de joins pelo grafo de FKs |
| `plan_query` | Gera plano de consulta a partir de objetivo em linguagem natural |
| `validate_query` | Analisa SQL antes de executar, com risco e avisos |

---

## Novidades da v2

- Catalogo de metadata em memoria com TTL configuravel
- Busca por intencao com ranking por tabela, coluna, descricao e relacionamentos
- Grafo de relacionamentos para sugestao de joins
- Validacao previa de SQL com analise de operacao, tabelas e avisos
- Paginacao de resultados no render da tool `query`
- Tools voltadas para agentes: `plan_query`, `explain_table`, `query_with_explanation`

---

## Requisitos

- [Node.js](https://nodejs.org/) v18 ou superior
- Acesso a um SQL Server (local ou remoto)

---

## Instalacao

### Passo 1 - Baixar o projeto

Clone ou copie esta pasta para qualquer local na sua maquina. Exemplo:

```
C:\MCP\mcp-sqlserver\
```

### Passo 2 - Instalar dependencias

```bash
cd C:\MCP\mcp-sqlserver
npm install
```

### Passo 3 - Configurar na sua ferramenta

Veja a secao [Configuracao por ferramenta](#configuracao-por-ferramenta) abaixo.

### Passo 4 - Reiniciar a ferramenta

Feche e abra a ferramenta. Ela detecta a configuracao automaticamente e conecta ao banco.

**Pronto!** A IA agora consegue consultar seu banco direto na conversa.

---

## Variaveis de ambiente

| Variavel | Obrigatoria | Padrao | Descricao |
|----------|-------------|--------|-----------|
| `DB_SERVER` | Nao | `localhost` | Endereco do SQL Server (ver exemplos abaixo) |
| `DB_DATABASE` | **Sim** | - | Nome do banco de dados |
| `DB_USER` | Nao | - | Usuario SQL. Se omitido, usa Windows Auth |
| `DB_PASSWORD` | Nao | - | Senha SQL. Se omitido, usa Windows Auth |
| `DB_PORT` | Nao | `1433` | Porta do SQL Server (ignorada se usar instancia nomeada) |
| `DB_ALLOW_WRITE` | Nao | - | Operacoes de escrita permitidas (ver abaixo) |
| `DB_ALLOW_TABLES` | Nao | - | Restringe escrita a tabelas especificas (ver abaixo) |
| `DB_ALLOW_SCHEMAS` | Nao | - | Restringe escrita a schemas especificos (ver abaixo) |

---

## Permissoes de escrita

Por padrao o servidor opera em **modo somente leitura** (apenas SELECT).

### DB_ALLOW_WRITE — habilitar operacoes

Define quais tipos de operacao SQL podem ser executados:

```json
"DB_ALLOW_WRITE": "INSERT,UPDATE,DELETE"
```

| Operacao | Risco | Descricao |
|----------|-------|-----------|
| `INSERT` | Baixo | Inserir registros |
| `UPDATE` | Medio | Atualizar registros |
| `DELETE` | Alto | Remover registros |
| `MERGE` | Alto | Insert/update/delete combinados |
| `CREATE` | Alto | Criar tabelas, views, indices |
| `ALTER` | Alto | Alterar estrutura de tabelas |
| `DROP` | Critico | Remover tabelas/objetos permanentemente |
| `TRUNCATE` | Critico | Esvaziar tabela sem rollback |

### DB_ALLOW_SCHEMAS — restringir por schema

Mesmo com escrita habilitada, limita as operacoes a schemas especificos:

```json
"DB_ALLOW_WRITE": "INSERT,UPDATE,DELETE",
"DB_ALLOW_SCHEMAS": "staging,temp"
```

Qualquer tentativa de escrever em outro schema sera bloqueada.

### DB_ALLOW_TABLES — restringir por tabela

Restringe escrita a uma lista explicita de tabelas:

```json
"DB_ALLOW_WRITE": "INSERT,UPDATE",
"DB_ALLOW_TABLES": "dbo.Produto,dbo.Pedido"
```

Pode-se omitir o schema (assume `dbo`): `"DB_ALLOW_TABLES": "Produto,Pedido"`.

### Operacoes permanentemente bloqueadas

Estas operacoes **nunca** podem ser habilitadas, independente da configuracao:

`EXEC`, `EXECUTE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `DBCC`, `BULK`, `OPENROWSET`, `OPENDATASOURCE`, `xp_*`, `sp_*`

### Comportamento de queries de escrita

- Executadas dentro de uma **transacao automatica** — rollback em caso de erro
- Registradas no **stderr** com timestamp, operacao e tabela alvo:
  ```
  [2024-01-15 10:30:45] WRITE  INSERT → dbo.Produto  (3 row(s) affected)
  ```

> **Dica:** Use a ferramenta `permissions` para ver em tempo real tudo que esta permitido ou bloqueado.

---

## Formatos de DB_SERVER

| Formato | Exemplo | Uso |
|---------|---------|-----|
| Localhost | `localhost` | SQL Server local, instancia padrao |
| IP | `192.168.1.100` | Servidor remoto por IP |
| Nome da maquina | `SERVIDOR-SQL` | Servidor por nome na rede |
| Instancia nomeada (\\) | `LAPTOP-ABC\\SQLEXPRESS` | Instancia nomeada (usar `\\` no JSON) |
| Instancia nomeada (/) | `LAPTOP-ABC/SQLEXPRESS` | Instancia nomeada (alternativa com `/`) |

> **Dica:** No JSON, a barra invertida precisa ser escapada (`\\`). Para simplificar, voce pode usar `/` no lugar — o MCP converte automaticamente.

### Como descobrir a porta do SQL Server

```sql
SELECT DISTINCT local_tcp_port FROM sys.dm_exec_connections WHERE local_tcp_port IS NOT NULL
```

---

## Configuracao por ferramenta

### Claude Code (VSCode ou CLI)

Crie um arquivo `.mcp.json` na **raiz do projeto**:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["C:/MCP/mcp-sqlserver/src/index.js"],
      "env": {
        "DB_SERVER": "localhost",
        "DB_DATABASE": "NomeDoBanco",
        "DB_USER": "sa",
        "DB_PASSWORD": "SuaSenha"
      }
    }
  }
}
```

### Cursor

1. Abra **Settings** > **MCP**
2. Clique em **Add new MCP server**
3. Cole a configuracao acima

### Windsurf

Adicione ao arquivo `~/.codeium/windsurf/mcp_config.json` com a configuracao acima.

### Codex / Cline

Adicione ao arquivo de configuracao MCP da ferramenta com a configuracao acima.

---

## Exemplos de configuracao

### Somente leitura (padrao)

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!"
}
```

### Windows Auth

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco"
}
```

### Instancia nomeada

```json
"env": {
  "DB_SERVER": "LAPTOP-ABC/SQLEXPRESS",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!"
}
```

### Escrita apenas em tabelas especificas

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!",
  "DB_ALLOW_WRITE": "INSERT,UPDATE",
  "DB_ALLOW_TABLES": "dbo.Produto,dbo.Pedido"
}
```

### Escrita restrita ao schema de staging

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!",
  "DB_ALLOW_WRITE": "INSERT,UPDATE,DELETE",
  "DB_ALLOW_SCHEMAS": "staging"
}
```

### Servidor remoto com porta customizada

```json
"env": {
  "DB_SERVER": "192.168.1.100",
  "DB_PORT": "1450",
  "DB_DATABASE": "Producao",
  "DB_USER": "app_user",
  "DB_PASSWORD": "S3nh@Segura"
}
```

---

## Seguranca

- Modo **somente leitura por padrao** — escrita requer configuracao explicita
- Escrita controlada por 3 camadas: operacao (`DB_ALLOW_WRITE`), schema (`DB_ALLOW_SCHEMAS`), tabela (`DB_ALLOW_TABLES`)
- Queries de escrita executadas em **transacao automatica** com rollback em erro
- **Log de auditoria** de todas as operacoes de escrita no stderr
- Comandos de administracao permanentemente bloqueados: `EXEC`, `GRANT`, `BACKUP`, `SHUTDOWN`, `xp_*`, `sp_*` e outros
- Maximo de **1000 linhas** por query SELECT
- Connection pooling com limite de 5 conexoes
- **Validacao de conexao na inicializacao** — falha rapida com mensagem clara se o banco nao estiver acessivel

---

## Nao precisa subir servidor

A ferramenta inicia e encerra o processo MCP automaticamente via stdio.
Voce **nao precisa** rodar nenhum comando manualmente — basta configurar e reiniciar.

---

## Estrutura do projeto

```
mcp-sqlserver/
├── .gitignore
├── .mcp.json.example    <- Template de configuracao
├── README.md            <- Este arquivo
├── package.json
└── src/
    └── index.js         <- Codigo do servidor MCP
```
