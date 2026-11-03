-- Runs only on first initialisation of the Postgres volume.
-- The default POSTGRES_DB (mlops) is created by the image entrypoint.
CREATE DATABASE mlflow OWNER mlops;
