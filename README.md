# TS4 Mod Manager

Gerenciador de mods para **The Sims 4** com interface inspirada no **Fluent 2** (Windows).

![Version](https://img.shields.io/badge/version-1.0.0-teal)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-28-brightgreen)

---

## ✨ Funcionalidades

### 🏠 Dashboard
- Total de mods instalados, ativos e inativos
- Status das pastas do jogo (detectadas automaticamente)
- Ações rápidas para as funções mais usadas

### 🎮 Gerenciamento de Mods
- Lista completa de mods com busca, filtros e ordenação
- Colunas redimensionáveis e ordenáveis por clique
- Ativar/desativar mods individualmente ou em lote
- Importar mods por **arrastar e soltar** ou seleção de arquivos
- Suporte a `.zip`, `.rar`, `.7z` (com 7-Zip instalado), `.package`, `.ts4script` e arquivos de Tray
- Deletar mods com confirmação
- **Desfazer** operações em lote

### ⚠️ Detecção de Conflitos
- Detecção de arquivos com **mesmo nome**
- Detecção de **conteúdo idêntico** por hash MD5
- Detecção de **duplicatas geradas pelo SO** (ex: `arquivo (2).package`)
- Opções para deletar arquivos conflitantes

### 📁 Organização Automática
- Detecta `.ts4script` com mais de 1 nível de subpasta
- Detecta arquivos de Tray dentro da pasta Mods (e vice-versa)
- Corrige individualmente ou todos de uma vez
- Suporte a **desfazer** movimentações

### ⚙️ Configurações
- Configuração manual das pastas Mods e Tray
- Atalho para abrir pastas no Explorer

---

## 📋 Regras de Subpastas do The Sims 4

| Tipo de arquivo | Profundidade máxima | Pasta correta |
|---|---|---|
| `.package` | 5 subpastas | Mods |
| `.ts4script` | **1 subpasta** | Mods |
| `.trayitem`, `.blueprint`, `.bpi`, `.hhi`, `.sgi`, `.householdbinary`, `.room`, `.rmi` | — | Tray |

> ⚠️ **Importante:** Não crie uma pasta chamada `Mods` dentro da pasta `Mods`, pois pode causar erros no jogo.

---

## 🚀 Instalação e Execução

### Pré-requisitos
- [Node.js](https://nodejs.org/) (v18 ou superior)
- [7-Zip](https://www.7-zip.org/) (opcional, para extrair `.rar` e `.7z`)

### Desenvolvimento
```bash
# Instalar dependências
npm install

# Executar em modo de desenvolvimento
npm start
```

### Build (Windows)
```bash
npm run build
```
O instalador será gerado em `dist/`.

---

## 📂 Estrutura do Projeto

```
├── main.js          # Processo principal do Electron (lógica de arquivos)
├── preload.js       # Bridge segura entre main e renderer
├── src/
│   ├── index.html   # Shell da janela
│   ├── styles.css   # Estilos Fluent 2
│   └── renderer.js  # Interface e lógica do frontend
├── assets/          # Ícones e recursos
└── package.json
```

---

## 🔢 Versionamento

Este projeto usa [SemVer](https://semver.org/lang/pt-BR/) para versionamento.  
Consulte o [CHANGELOG.md](CHANGELOG.md) para o histórico de versões.

---

## 📄 Licença

MIT © testaccount82
