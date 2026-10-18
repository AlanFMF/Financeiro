-- Assistente pelo WhatsApp (Cloud API oficial da Meta).

-- Número de WhatsApp ligado a cada conta (wa_id é o número no formato da Meta, só dígitos).
create table whatsapp_links (
  user_id   integer primary key references users(id) on delete cascade,
  wa_id     text not null unique,
  linked_at timestamptz not null default now()
);

-- Código de 6 dígitos para ligar o número, válido por alguns minutos (guardado só o hash).
create table whatsapp_codes (
  user_id    integer primary key references users(id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null
);

-- Conversa recente (contexto para correções como "na verdade foi 50") e trava contra mensagem repetida:
-- a Meta pode entregar o mesmo aviso mais de uma vez, e o id da mensagem é a chave.
create table whatsapp_messages (
  id         text primary key,
  wa_id      text not null,
  user_id    integer references users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index whatsapp_messages_wa_idx on whatsapp_messages (wa_id, created_at desc);
