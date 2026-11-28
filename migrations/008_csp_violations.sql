-- CSP violation reports from our own pages (POST /api/v1/csp-report), counted per site, page,
-- directive and blocked source. No query strings, no reporter IP addresses.
CREATE TABLE csp_violations (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  page text NOT NULL,
  directive text NOT NULL,
  blocked text NOT NULL,
  enforced boolean NOT NULL,
  count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, page, directive, blocked, enforced)
);
CREATE INDEX csp_violations_last_seen ON csp_violations (last_seen_at DESC);
