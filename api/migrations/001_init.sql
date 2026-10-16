-- Esquema inicial do Saldo.
-- Valores sempre em centavos (inteiro) para não ter erro de arredondamento.

create table users (
  id            serial primary key,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now()
);

create table categories (
  id         serial primary key,
  user_id    integer not null references users(id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('entrada', 'saida')),
  color      text not null default '#5B6870',
  position   integer not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name, kind)
);

create table transactions (
  id           serial primary key,
  user_id      integer not null references users(id) on delete cascade,
  category_id  integer not null references categories(id) on delete restrict,
  date         date not null,
  description  text not null default '',
  amount_cents integer not null check (amount_cents > 0),
  is_fixed     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index transactions_user_date_idx on transactions (user_id, date);
create index transactions_category_idx on transactions (category_id);
