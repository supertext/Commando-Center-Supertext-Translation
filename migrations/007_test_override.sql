-- Staff can mark an installation as a test installation or as a real one by hand. NULL: automatic (the
-- installation counts as a test installation when its host is local or a test host, column local).
ALTER TABLE installations ADD COLUMN test_override boolean;
