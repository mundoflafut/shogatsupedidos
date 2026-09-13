# Shogatsu v141

Versão focada em restaurar o cardápio real da versão antiga e migrar as fotos para o Supabase Storage.

## Render
Mantenha apenas as variáveis já existentes:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Não é necessário `SUPABASE_STORAGE_BUCKET`.

O bucket usado é fixamente `BANCO DE FOTS` e deve continuar público.

## Comportamento
No boot, o servidor restaura `shogatsu_kv`, reconcilia o cardápio com `menu_categories/menu_items` quando necessário e só então libera `/api/config`. Fotos legadas são migradas para o Storage sem apagar o backup antigo.
