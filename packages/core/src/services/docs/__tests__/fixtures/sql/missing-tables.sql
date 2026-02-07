CREATE TABLE rights_policies (
  id INTEGER PRIMARY KEY
);
CREATE TABLE data_export_jobs (
  id INTEGER PRIMARY KEY
);
CREATE TABLE rights_policy_links (
  id INTEGER PRIMARY KEY,
  rights_policies_id INTEGER
);
