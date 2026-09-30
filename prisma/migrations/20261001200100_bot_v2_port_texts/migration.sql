-- Bot v2: porta os textos que a empresa EDITOU na v1 para as chaves novas (docs/bot-v2-plano.md
-- §3.1). Idempotente (ON CONFLICT DO NOTHING) e sem apagar as linhas legadas.
--   MAIN_MENU            -> MENU_PROMPT       (texto antes da 1ª linha que começa com opção)
--   APPOINTMENT_ACTIONS  -> APPOINTMENT_DETAIL (2 linhas de detalhe + cabeçalho extraído igual)
-- Regra do cabeçalho: linhas antes da 1ª que casa ^\s*([0-9]+|[0-9]️⃣)\s*[.)\-:–]?\s ; se nenhuma
-- linha for de opção, o cabeçalho é o texto inteiro; aparado; vazio => não porta.
-- Não portadas (mudaram de significado, spec §8): TOO_MANY_INVALID, LABEL_BACK_TO_MENU, LABEL_OTHER_TIME.
DO $$
DECLARE
  m RECORD;
  n INTEGER;
BEGIN
  FOR m IN SELECT * FROM (VALUES
    ('MAIN_MENU'::"BotTextKey", 'MENU_PROMPT'::"BotTextKey", ''::text),
    ('APPOINTMENT_ACTIONS'::"BotTextKey", 'APPOINTMENT_DETAIL'::"BotTextKey", '*{servico}* com {profissional}' || E'\n' || '{data_longa} às *{hora}*' || E'\n\n')
  ) AS t(src, dst, prefix)
  LOOP
    WITH lines AS (
      SELECT b."tenantId", b."text", l.line, l.ord
      FROM "bot_texts" b,
      LATERAL regexp_split_to_table(b."text", E'\n') WITH ORDINALITY AS l(line, ord)
      WHERE b."key" = m.src
    ),
    first_opt AS (
      SELECT "tenantId", min(ord) AS ord
      FROM lines
      WHERE (line || E'\n') ~ '^\s*([0-9]+|[0-9]\uFE0F?\u20E3)\s*[.)\-:–]?\s'
      GROUP BY "tenantId"
    ),
    header AS (
      SELECT b."tenantId",
             btrim(coalesce((
               SELECT string_agg(l.line, E'\n' ORDER BY l.ord)
               FROM lines l
               WHERE l."tenantId" = b."tenantId"
                 AND (f.ord IS NULL OR l.ord < f.ord)
             ), ''), E' \t\r\n') AS h
      FROM "bot_texts" b
      LEFT JOIN first_opt f ON f."tenantId" = b."tenantId"
      WHERE b."key" = m.src
    )
    INSERT INTO "bot_texts" ("id", "tenantId", "key", "text", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, "tenantId", m.dst, m.prefix || h, now(), now()
    FROM header
    WHERE h <> ''
    ON CONFLICT ("tenantId", "key") DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'bot v2: % -> % : % linha(s) portada(s)', m.src, m.dst, n;
  END LOOP;
END $$;
