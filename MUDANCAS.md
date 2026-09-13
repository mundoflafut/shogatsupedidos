# Shogatsu v141 — sincronização real do cardápio + fotos legadas

- Corrige a origem do cardápio: o `shogatsu_kv/config` não é mais sobrescrito cegamente pelo `default-menu.json`.
- Recupera o cardápio antigo das tabelas `menu_categories` + `menu_items` quando elas têm mais dados ou são mais recentes.
- Preserva edições novas do painel quando o `config` é mais recente.
- Recupera configurações e cardápio completos antes de liberar `/api/config` ao cliente.
- Localiza fotos antigas também dentro de `menu_items`.
- Migra fotos `upload_*.jpg/png/webp` do backup Base64 para o bucket público `BANCO DE FOTS`.
- Se a foto já estiver no Storage, não faz novo upload.
- Novos uploads de fotos continuam usando o Storage.
- Mantém fallback `/uploads/`.
- Não apaga `shogatsu_kv`, pedidos, clientes, produtos ou fotos antigas.
- Não altera layout do cardápio, Kanban, impressão ou login.
- Mantém `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` como únicas variáveis necessárias no Render.
