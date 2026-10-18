-- Bucket privado para los Excel generados por las edge functions de
-- exportación. Privado: solo se accede con URL firmada (o service role).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'exportaciones',
  'exportaciones',
  false,
  10485760,
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
ON CONFLICT (id) DO NOTHING;
