-- Two isolated, protected tenants for the realtime live authorization receipt
-- (honua-sdk-js#1692, honua-server#3871).
--
-- Applied to a server-migrated database after the candidate revision's own
-- tests/seed/client-compat-v1.sql, then the candidate server is restarted so
-- the cached Metadata v2 graph is reloaded. The seed publishes point layers 10
-- and 11 on the shared features table; this overlay scopes layer 10 to
-- tenant-a and layer 11 to tenant-b, refuses anonymous callers and admits only
-- the "reader" role. The shared test_service stays unscoped, mirroring the
-- server's own FeatureStreamEndpointsTests.Authorization fixture.
DO $$
DECLARE
    snapshot record;
    doc jsonb;
    scoped integer;
    new_etag text;
BEGIN
    FOR snapshot IN SELECT environment, revision, document FROM honua.metadata_v2_snapshots LOOP
        SELECT
            jsonb_agg(
                CASE
                    WHEN r.value -> 'metadata' ->> 'id' IN ('res-layer-10', 'res-image-layer-10') THEN
                        jsonb_set(
                            jsonb_set(r.value, '{metadata,tenant}', '"tenant-a"'),
                            '{accessPolicy}',
                            '{"allowAnonymous": false, "allowedRoles": ["reader", "editor"], "allowedWriteRoles": ["editor"]}')
                    WHEN r.value -> 'metadata' ->> 'id' IN ('res-layer-11', 'res-image-layer-11') THEN
                        jsonb_set(
                            jsonb_set(r.value, '{metadata,tenant}', '"tenant-b"'),
                            '{accessPolicy}',
                            '{"allowAnonymous": false, "allowedRoles": ["reader", "editor"], "allowedWriteRoles": ["editor"]}')
                    ELSE r.value
                END
                ORDER BY r.ordinality),
            count(*) FILTER (WHERE r.value -> 'metadata' ->> 'id' IN ('res-layer-10', 'res-layer-11'))
        INTO doc, scoped
        FROM jsonb_array_elements(snapshot.document -> 'resources') WITH ORDINALITY AS r(value, ordinality);

        -- Only seeded environments carry the layers; a server-created snapshot
        -- for another environment is left untouched.
        CONTINUE WHEN scoped = 0;
        IF scoped <> 2 THEN
            RAISE EXCEPTION 'snapshot %/% must publish res-layer-10 and res-layer-11, found %',
                snapshot.environment, snapshot.revision, scoped;
        END IF;

        doc := jsonb_set(snapshot.document, '{resources}', doc);
        new_etag := '"' || md5(doc::text) || '"';
        UPDATE honua.metadata_v2_snapshots
        SET document = doc, etag = new_etag
        WHERE environment = snapshot.environment AND revision = snapshot.revision;
        UPDATE honua.metadata_v2_current
        SET etag = new_etag
        WHERE environment = snapshot.environment AND revision = snapshot.revision;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM honua.metadata_v2_current c
        JOIN honua.metadata_v2_snapshots s ON s.environment = c.environment AND s.revision = c.revision
        WHERE c.environment = 'Production'
          AND s.document -> 'resources' @> '[{"metadata": {"id": "res-layer-10", "tenant": "tenant-a"}}]'
          AND s.document -> 'resources' @> '[{"metadata": {"id": "res-layer-11", "tenant": "tenant-b"}}]'
    ) THEN
        RAISE EXCEPTION 'the active Production snapshot does not scope layers 10 and 11 to tenant-a and tenant-b';
    END IF;
END
$$;
