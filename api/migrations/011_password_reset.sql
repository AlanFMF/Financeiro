-- Recuperação de senha: código de 6 dígitos, guardado só como hash, válido por 15 minutos e com tentativas limitadas.
create table password_resets (
  id         serial primary key,
  user_id    integer not null references users(id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index password_resets_user on password_resets (user_id, created_at desc);

-- Cada troca de senha sobe a versão; sessões com a versão antiga deixam de valer.
alter table users add column password_version integer not null default 0;
