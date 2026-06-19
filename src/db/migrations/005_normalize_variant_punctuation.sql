-- Strip trailing punctuation from term_variants.value
-- Handles Devanagari danda (।), double danda (॥), and ASCII . ! ? ,
-- Run once — idempotent (rows with no trailing punctuation are unaffected)

UPDATE term_variants
SET value = regexp_replace(value, '[।॥\.!?,\s]+$', '')
WHERE value ~ '[।॥\.!?,\s]+$';
