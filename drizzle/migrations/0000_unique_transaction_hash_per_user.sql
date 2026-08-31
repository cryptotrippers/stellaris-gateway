CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_tx_hash_key
  ON public.transactions (user_id, tx_hash);