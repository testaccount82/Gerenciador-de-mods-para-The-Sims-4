# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

---

## [1.1.0] - 2025-01-08

### Corrigido
- Detecção real das pastas Mods e Tray via `fs.existsSync` no processo principal — antes qualquer caminho configurado era incorretamente marcado como detectado
- Removido `...` (ellipsis) que aparecia na coluna de checkbox da tabela de mods devido ao padding excessivo
- Filtro de pastas na página Mods não exibe mais `/` como opção inválida
- Ícone da janela trocado de escudo para controle de videogame
- Cor de destaque alterada de teal para azul Fluent (#0078D4); texto dos botões primários e thumb do toggle ajustados para branco
- Caminho completo do arquivo agora é exibido abaixo do nome nos cards de conflito
- Adicionado suporte a **Desfazer** ao deletar arquivos na página de Conflitos (arquivo é movido para lixeira temporária em vez de deletado permanentemente)

---

## [1.0.0] - 2025-01-01

### Adicionado
- **Dashboard** com estatísticas de mods ativos, inativos e total
- **Status de pastas** com detecção automática das pastas Mods e Tray
- **Gerenciador de Mods** com listagem completa, busca e filtros
- **Importação de mods** via arrastar e soltar ou seleção de arquivo
- Suporte a arquivos `.zip`, `.rar`, `.7z`, `.package`, `.ts4script` e arquivos de Tray
- **Ativar/Desativar** mods individualmente ou em lote
- **Deletar** mods individualmente ou em lote com confirmação
- **Desfazer** operações em lote (desativar, mover)
- **Tabela de mods** com colunas redimensionáveis e ordenação crescente/decrescente
- **Filtros** por status (ativo/inativo), tipo de arquivo e pasta
- **Detecção de Conflitos** por nome, conteúdo (hash MD5) e duplicatas do SO
- **Organização Automática** para detectar e corrigir arquivos mal colocados
- Detecção de `.ts4script` com mais de 1 nível de subpasta
- Detecção de arquivos de Tray na pasta Mods (e vice-versa)
- **Configurações** para definir manualmente as pastas do jogo
- Interface **Fluent 2** com tema escuro e acento teal do The Sims 4
- Janela sem borda com barra de título personalizada e arrasto para mover
- Notificações toast para feedback de ações
- Modal de confirmação para ações destrutivas
- Barra de Desfazer para reverter operações

---

[1.0.0]: https://github.com/testaccount82/Gerenciador-de-mods-para-The-Sims-4/releases/tag/v1.0.0
