-- Cada usuário conecta a própria IA. A chave fica criptografada (AES-256-GCM) e nunca volta para o navegador.
create table ai_settings (
  user_id       integer primary key references users(id) on delete cascade,
  provider      text not null check (provider in ('claude', 'openai', 'gemini')),
  model         text not null,
  key_encrypted text not null,
  key_hint      text not null,
  updated_at    timestamptz not null default now()
);
