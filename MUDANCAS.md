# v142 — Cardápio e fotos legados

- Reconciliacao segura do cardápio atual com fontes legadas do Supabase, sem substituir atualizações existentes.
- Migração de todas as fotos `upload_*` encontradas em `shogatsu_kv` para o bucket público `BANCO DE FOTS`.
- Paginação explícita até 1000 registros para não parar na 100ª foto/item.
- Atualiza referências de fotos no `config` e confirma o backup após a migração.
- Novos uploads continuam usando Supabase Storage.
- Nenhum dado de pedidos/clientes é apagado.
