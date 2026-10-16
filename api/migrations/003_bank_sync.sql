-- Sincronização com o banco (Open Finance) feita por uma tarefa agendada.

-- Chaves de acesso que só podem enviar lançamentos do banco (/api/sync).
-- Guardamos só o hash; a chave aparece uma única vez, na criação.
create table api_tokens (
  id           serial primary key,
  user_id      integer not null references users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  token_hint   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- De onde veio o lançamento ("Nubank conta", "Nubank cartão"); vazio quando foi lançado à mão ou pelo chat.
alter table transactions add column source text;

-- Cada id de transação do banco já visto e o lançamento a que corresponde.
-- Um lançamento pode ter mais de um id (o banco troca o id quando a compra sai de pendente para confirmada).
-- Se o lançamento for apagado, a referência fica com transaction_id nulo e a transação não volta a ser importada.
create table bank_refs (
  user_id        integer not null references users(id) on delete cascade,
  external_id    text not null,
  transaction_id integer references transactions(id) on delete set null,
  status         text,
  created_at     timestamptz not null default now(),
  primary key (user_id, external_id)
);
create index bank_refs_transaction_idx on bank_refs (transaction_id);
