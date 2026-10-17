-- Metas de gasto por categoria: um limite mensal que vale para todos os meses.
alter table categories add column budget_cents integer check (budget_cents is null or budget_cents > 0);

-- Avisos de meta já mostrados (80% e 100%), para cada aviso aparecer uma vez por mês.
create table budget_alerts (
  user_id     integer not null references users(id) on delete cascade,
  category_id integer not null references categories(id) on delete cascade,
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  level       integer not null check (level in (80, 100)),
  created_at  timestamptz not null default now(),
  primary key (user_id, category_id, month, level)
);
