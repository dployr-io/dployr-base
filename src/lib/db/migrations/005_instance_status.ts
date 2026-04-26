export const _005_instance_status = `
DO $$ BEGIN
  CREATE TYPE instance_status AS ENUM ('healthy', 'degraded', 'offline', 'unreachable', 'maintenance');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE instances ADD COLUMN IF NOT EXISTS status instance_status NOT NULL DEFAULT 'healthy';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instance_pool' AND column_name = 'status_new'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instance_pool' AND column_name = 'status' AND udt_name = 'text'
  ) THEN
    ALTER TABLE instance_pool ADD COLUMN status_new instance_status NOT NULL DEFAULT 'healthy';
    UPDATE instance_pool SET status_new = CASE
      WHEN status = 'active' THEN 'healthy'::instance_status
      WHEN status = 'paused' THEN 'maintenance'::instance_status
      ELSE 'healthy'::instance_status
    END;
    ALTER TABLE instance_pool DROP COLUMN status;
    ALTER TABLE instance_pool RENAME COLUMN status_new TO status;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_instance_pool_status;
CREATE INDEX IF NOT EXISTS idx_instance_pool_status ON instance_pool(status);
`;