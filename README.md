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
