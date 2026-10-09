-- SelectBench domain membership is a per-case human annotation, never inferred for old runs.
ALTER TABLE selectbench_results ADD COLUMN domains text[] NOT NULL DEFAULT '{}';
