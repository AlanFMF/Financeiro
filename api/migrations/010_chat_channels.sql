-- Assistente por mensagem em mais de um canal (WhatsApp e Telegram): as tabelas do WhatsApp viram genéricas.

create table chat_links (
  user_id     integer not null references users(id) on delete cascade,
  channel     text not null check (channel in ('whatsapp', 'telegram')),
  external_id text not null,
  linked_at   timestamptz not null default now(),
  primary key (user_id, channel),
  unique (channel, external_id)
);

create table chat_codes (
  user_id    integer not null references users(id) on delete cascade,
  channel    text not null check (channel in ('whatsapp', 'telegram')),
  code_hash  text not null,
  expires_at timestamptz not null,
  primary key (user_id, channel)
);

create table chat_messages (
  id          text primary key,
  channel     text not null check (channel in ('whatsapp', 'telegram')),
  external_id text not null,
  user_id     integer references users(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index chat_messages_conversation_idx on chat_messages (channel, external_id, created_at desc);

insert into chat_links (user_id, channel, external_id, linked_at) select user_id, 'whatsapp', wa_id, linked_at from whatsapp_links;
insert into chat_messages (id, channel, external_id, user_id, role, content, created_at)
  select 'whatsapp:' || id, 'whatsapp', wa_id, user_id, role, content, created_at from whatsapp_messages;

drop table whatsapp_messages;
drop table whatsapp_codes;
drop table whatsapp_links;
