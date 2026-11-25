-- Legacy sources are append-only notes. Expose their original text as one citable passage.
CREATE OR REPLACE VIEW cw_chat_note_documents AS
SELECT id, item_id, title, as_of,
       COALESCE(document, jsonb_build_object(
         'id', id, 'itemId', item_id, 'title', title, 'source', source, 'kind', 'Source note',
         'asOf', to_char(as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'version', 1,
         'anchors', jsonb_build_array(jsonb_build_object('id', 'body', 'label', title, 'text', body))
       )) AS document
FROM cw_evidence;
