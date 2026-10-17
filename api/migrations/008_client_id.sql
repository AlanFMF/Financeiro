-- Lançamentos feitos sem internet chegam com um id gerado no aparelho.
-- Se o envio for repetido (a rede caiu depois de o servidor gravar), o mesmo id não vira um segundo lançamento.
alter table transactions add column client_id text;
create unique index transactions_client_id_idx on transactions (user_id, client_id) where client_id is not null;
