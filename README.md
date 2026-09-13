# Shogatsu v120

Evolução administrativa focada em simplicidade, digitação rápida, responsividade e estética japonesa premium.

A impressão automática e os recursos existentes permanecem compatíveis.


## v137 — Supabase Storage para fotos do cardápio

Não é necessário criar nenhuma variável nova no Render para o Storage. A versão usa diretamente o bucket público existente `BANCO DE FOTS`. O bucket deve existir e estar público. A v137 migra referências antigas `/uploads/...` do `config.json` para URLs públicas do Storage e envia novas fotos diretamente para o bucket. O backup Base64 antigo deixa de ser usado depois da migração, reduzindo Egress em redeploys. A `service_role` fica somente no servidor e nunca é enviada ao navegador.


## v139 — restauração segura do cardápio e fotos
- O endpoint público `/api/config` aguarda a restauração do backup real do restaurante antes de entregar o menu.
- O cliente tenta novamente durante a restauração, evitando mostrar o `DEFAULT_MENU` do ZIP.
- O servidor registra a quantidade de categorias e pratos efetivamente restaurados.
- O bucket de fotos continua fixo em `BANCO DE FOTS`; nenhuma variável `SUPABASE_STORAGE_BUCKET` é necessária.


## v140 — migração do cardápio antigo
- O cardápio público aguarda a restauração do Supabase antes de responder `/api/config`, evitando exibir `default-menu.json`.
- Se o backup antigo não tiver `menu`, procura as chaves legadas `menu`, `cardapio`, `menu_data`, `cardapio_data`, `menu_config`, `cardapio_config` em `shogatsu_kv`.
- Como fallback, lê `menu_categories` e `menu_items` existentes no Supabase e adapta para o formato antigo do cardápio.
- Fotos antigas `upload_*` são migradas para o bucket público `BANCO DE FOTS`; as referências do cardápio são atualizadas e o `config` corrigido volta ao Supabase.
- Novas fotos continuam usando `/api/upload` e o Storage; `SUPABASE_STORAGE_BUCKET` não é necessário.
- Não apagar os registros antigos `upload_*` antes de validar o cardápio e as fotos.
