-- Cada chave serve para uma coisa só: 'sync' (tarefa do banco) ou 'mcp' (conector do Claude).
alter table api_tokens add column scope text not null default 'sync' check (scope in ('sync', 'mcp'));
