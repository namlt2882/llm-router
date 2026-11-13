-- +goose Up
-- The router's Postgres mirror, exactly as the router used to create it at
-- boot: every column text, one bigserial key, no indexes. Unquoted identifiers
-- fold to lower case; the router's in-memory SQLite is case-insensitive.
CREATE TABLE _meta (key text, value text, PRIMARY KEY (key));
CREATE TABLE settings (id text, data text, PRIMARY KEY (id));
CREATE TABLE providerConnections (id text, provider text, authType text, name text, email text, priority text, isActive text, data text, createdAt text, updatedAt text, PRIMARY KEY (id));
CREATE TABLE providerNodes (id text, type text, name text, data text, createdAt text, updatedAt text, PRIMARY KEY (id));
CREATE TABLE proxyPools (id text, isActive text, testStatus text, data text, createdAt text, updatedAt text, PRIMARY KEY (id));
CREATE TABLE apiKeys (id text, key text, name text, machineId text, isActive text, createdAt text, accessRestricted text, accessAllow text, PRIMARY KEY (id));
CREATE TABLE combos (id text, name text, kind text, models text, createdAt text, updatedAt text, PRIMARY KEY (id));
CREATE TABLE kv (scope text, key text, value text, PRIMARY KEY (scope, key));
CREATE TABLE usageHistory (id bigserial PRIMARY KEY, timestamp text, provider text, model text, connectionId text, apiKey text, endpoint text, promptTokens text, completionTokens text, cost text, status text, tokens text, meta text);
CREATE TABLE usageDaily (dateKey text, data text, PRIMARY KEY (dateKey));
CREATE TABLE requestDetails (id text, timestamp text, provider text, model text, connectionId text, status text, data text, PRIMARY KEY (id));

-- +goose Down
DROP TABLE requestDetails;
DROP TABLE usageDaily;
DROP TABLE usageHistory;
DROP TABLE kv;
DROP TABLE combos;
DROP TABLE apiKeys;
DROP TABLE proxyPools;
DROP TABLE providerNodes;
DROP TABLE providerConnections;
DROP TABLE settings;
DROP TABLE _meta;
