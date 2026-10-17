-- Lançamentos que vieram do banco e ainda não foram conferidos pelo usuário (categoria escolhida pelo app).
alter table transactions add column needs_review boolean not null default false;
create index transactions_review_idx on transactions (user_id) where needs_review;

-- O que já foi importado nos últimos dias entra na lista para conferir.
update transactions set needs_review = true where source is not null and created_at > now() - interval '7 days';
