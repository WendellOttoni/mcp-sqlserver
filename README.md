# MCP SQL Server

Servidor MCP (Model Context Protocol) para **Microsoft SQL Server**.
Permite que ferramentas de IA explorem e consultem bancos SQL Server diretamente durante a conversa, em modo **somente leitura**.

Compativel com **Claude Code**, **Cursor**, **Windsurf**, **Codex**, **Cline**, **Continue** e qualquer ferramenta que suporte MCP.

---

## O que ele faz?

| Ferramenta | Descricao |
|------------|-----------|
| `list_schemas` | Lista todos os schemas do banco |
| `list_tables` | Lista tabelas e views (filtro por schema opcional) |
| `describe_table` | Mostra colunas, tipos, PKs e FKs de uma tabela |
| `find_columns` | Busca colunas por nome em todas as tabelas |
| `query` | Executa queries SELECT (INSERT/UPDATE/DELETE bloqueados) |

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

Se nao souber a porta, conecte com localhost primeiro e rode esta query via ferramenta `query`:

```sql
SELECT DISTINCT local_tcp_port FROM sys.dm_exec_connections WHERE local_tcp_port IS NOT NULL
```

---

## Configuracao por ferramenta

O bloco de configuracao base e o mesmo para todas as ferramentas:

```json
{
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
```

> **Importante:** Substitua o caminho em `args` pelo caminho real onde voce colocou a pasta.

---

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

Reinicie o Claude Code.

---

### Cursor

1. Abra **Settings** > **MCP**
2. Clique em **Add new MCP server**
3. Cole a configuracao:

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

---

### Codex

Adicione ao arquivo de configuracao MCP do Codex (mesmo local onde o Playwright esta configurado):

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

---

### Windsurf

Adicione ao arquivo `~/.codeium/windsurf/mcp_config.json`:

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

---

### Cline (VSCode)

1. Abra **Settings** > **MCP Servers**
2. Adicione um novo servidor com a configuracao acima

---

## Exemplos de configuracao

### SQL Server Auth (usuario e senha)

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!"
}
```

### Windows Auth (sem user/password)

```json
"env": {
  "DB_SERVER": "localhost",
  "DB_DATABASE": "MeuBanco"
}
```

### Instancia nomeada (SQL Express)

```json
"env": {
  "DB_SERVER": "LAPTOP-ABC/SQLEXPRESS",
  "DB_DATABASE": "MeuBanco",
  "DB_USER": "sa",
  "DB_PASSWORD": "MinhaS3nha!"
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

- Somente **SELECT** e permitido
- Comandos bloqueados: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `EXEC`, `MERGE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `DBCC`, `BULK`, `OPENROWSET`, `OPENDATASOURCE`, `xp_`, `sp_`
- Maximo de **1000 linhas** por query
- Connection pooling com limite de 5 conexoes

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
