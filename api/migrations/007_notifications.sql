-- Notificações no celular: chave própria (só lê as notificações) e até onde as importações já foram avisadas.
alter table api_tokens drop constraint if exists api_tokens_scope_check;
alter table api_tokens add constraint api_tokens_scope_check check (scope in ('sync', 'mcp', 'notify'));

create table notification_state (
  user_id             integer primary key references users(id) on delete cascade,
  imports_notified_at timestamptz not null default now()
);
