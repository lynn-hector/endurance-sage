// 由 scripts/build.mjs 生成（源：packages/core/env-matrix/envs.yml，勿手改；改环境请编辑 apps/agent/envs.yml）。
import type { Matrix } from '@dsh-sentry/env-matrix/pure'

export const MATRIX: Matrix = {
  "dev-platform-hosted-0": {
    "envLabel": "dev-platform-hosted-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-0.dev.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_DP0_USERNAME",
      "passwordRef": "GREPTIMEDB_DP0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-0.dev.novo-one.com",
      "greptimedbJaegerDatasourceUid": "GreptimeDB-Jaeger",
      "usernameRef": "GRAFANA_DP0_USERNAME",
      "passwordRef": "GRAFANA_DP0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-0.dev.novo-one.com",
      "passwordRef": "DBX_DP0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-0.dev.novo-one.com",
      "usernameRef": "ROCKETMQ_DP0_USERNAME",
      "passwordRef": "ROCKETMQ_DP0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "dev-platform-hosted-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "dev-platform-hosted-0"
    }
  },
  "dev-platform-hosted-1": {
    "envLabel": "dev-platform-hosted-1",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-1.dev.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_DP1_USERNAME",
      "passwordRef": "GREPTIMEDB_DP1_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-1.dev.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_DP1_USERNAME",
      "passwordRef": "GRAFANA_DP1_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-1.dev.novo-one.com",
      "passwordRef": "DBX_DP1_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-1.dev.novo-one.com",
      "usernameRef": "ROCKETMQ_DP1_USERNAME",
      "passwordRef": "ROCKETMQ_DP1_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "dev-platform-hosted-1",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "dev-platform-hosted-1"
    }
  },
  "dev-client-hosted-0": {
    "envLabel": "dev-client-hosted-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-0.dev-byoi.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_DC0_USERNAME",
      "passwordRef": "GREPTIMEDB_DC0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-0.dev-byoi.novo-one.com",
      "greptimedbJaegerDatasourceUid": "bfo3r2zfv3mkgb",
      "usernameRef": "GRAFANA_DC0_USERNAME",
      "passwordRef": "GRAFANA_DC0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-0.dev-byoi.novo-one.com",
      "passwordRef": "DBX_DC0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-1.dev.novo-one.com",
      "usernameRef": "ROCKETMQ_DC0_USERNAME",
      "passwordRef": "ROCKETMQ_DC0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "dev-client-hosted-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "dev-client-hosted-0"
    }
  },
  "tst-platform-hosted-0": {
    "envLabel": "tst-platform-hosted-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-0.test.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TP0_USERNAME",
      "passwordRef": "GREPTIMEDB_TP0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-0.test.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TP0_USERNAME",
      "passwordRef": "GRAFANA_TP0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-0.test.novo-one.com",
      "passwordRef": "DBX_TP0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-0.test.novo-one.com",
      "usernameRef": "ROCKETMQ_TP0_USERNAME",
      "passwordRef": "ROCKETMQ_TP0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-hosted-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-hosted-0"
    }
  },
  "tst-platform-hosted-1": {
    "envLabel": "tst-platform-hosted-1",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-1.test.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TP1_USERNAME",
      "passwordRef": "GREPTIMEDB_TP1_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-1.test.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TP1_USERNAME",
      "passwordRef": "GRAFANA_TP1_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-1.test.novo-one.com",
      "passwordRef": "DBX_TP1_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-1.test.novo-one.com",
      "usernameRef": "ROCKETMQ_TP1_USERNAME",
      "passwordRef": "ROCKETMQ_TP1_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-hosted-1",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-hosted-1"
    }
  },
  "tst-client-hosted-0": {
    "envLabel": "tst-client-hosted-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-0.test-byoi.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TC0_USERNAME",
      "passwordRef": "GREPTIMEDB_TC0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-0.test-byoi.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TC0_USERNAME",
      "passwordRef": "GRAFANA_TC0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-0.test-byoi.novo-one.com",
      "passwordRef": "DBX_TC0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-0.test-byoi.novo-one.com",
      "usernameRef": "ROCKETMQ_TC0_USERNAME",
      "passwordRef": "ROCKETMQ_TC0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-client-hosted-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-client-hosted-0"
    }
  },
  "sit-client-hosted-1": {
    "envLabel": "sit-client-hosted-1",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-1.sit-byoi.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_SC1_USERNAME",
      "passwordRef": "GREPTIMEDB_SC1_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-1.sit-byoi.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_SC1_USERNAME",
      "passwordRef": "GRAFANA_SC1_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-1.sit-byoi.novo-one.com",
      "passwordRef": "DBX_SC1_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-1.sit-byoi.novo-one.com",
      "usernameRef": "ROCKETMQ_SC1_USERNAME",
      "passwordRef": "ROCKETMQ_SC1_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "sit-client-hosted-1",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "sit-client-hosted-1"
    }
  },
  "sit-client-hosted-2": {
    "envLabel": "sit-client-hosted-2",
    "greptimedb": {
      "endpoint": "https://greptimedb.cn-2.sit-byoi.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_SC2_USERNAME",
      "passwordRef": "GREPTIMEDB_SC2_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.cn-2.sit-byoi.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_SC2_USERNAME",
      "passwordRef": "GRAFANA_SC2_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.cn-2.sit-byoi.novo-one.com",
      "passwordRef": "DBX_SC2_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.cn-2.sit-byoi.novo-one.com",
      "usernameRef": "ROCKETMQ_SC2_USERNAME",
      "passwordRef": "ROCKETMQ_SC2_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "sit-client-hosted-2",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "sit-client-hosted-2"
    }
  },
  "pro-br-saas-aws-eks-novo": {
    "envLabel": "pro-br-saas-aws-eks-novo",
    "greptimedb": {
      "endpoint": "https://greptimedb.br.novoone.com",
      "database": "public",
      "tokenRef": "GREPTIMEDB_PBO_CONNECT_TOKEN"
    },
    "grafana": {
      "endpoint": "https://grafana.br.novoone.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_PBO_USERNAME",
      "passwordRef": "GRAFANA_PBO_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.br.novoone.com",
      "passwordRef": "DBX_PBO_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.br.novoone.com",
      "usernameRef": "ROCKETMQ_PBO_USERNAME",
      "passwordRef": "ROCKETMQ_PBO_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "pro-br-saas-aws-eks-novo",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "pro-br-saas-aws-eks-novo"
    }
  },
  "tst-platform-aws-eks-sg-0": {
    "envLabel": "tst-platform-aws-eks-sg-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.sg-0.pre.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TPSG0_USERNAME",
      "passwordRef": "GREPTIMEDB_TPSG0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.sg-0.pre.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TPSG0_USERNAME",
      "passwordRef": "GRAFANA_TPSG0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.sg-0.pre.novo-one.com",
      "passwordRef": "DBX_TPSG0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.sg-0.pre.novo-one.com",
      "usernameRef": "ROCKETMQ_TPSG0_USERNAME",
      "passwordRef": "ROCKETMQ_TPSG0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-aws-eks-sg-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-aws-eks-sg-0"
    }
  },
  "pro-use-saas-aws-eks-novo": {
    "envLabel": "pro-use-saas-aws-eks-novo",
    "greptimedb": {
      "endpoint": "https://greptimedb.use.novoone.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_PUO_USERNAME",
      "passwordRef": "GREPTIMEDB_PUO_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.use.novoone.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_PUO_USERNAME",
      "passwordRef": "GRAFANA_PUO_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.use.novoone.com",
      "passwordRef": "DBX_PUO_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.use.novoone.com",
      "usernameRef": "ROCKETMQ_PUO_USERNAME",
      "passwordRef": "ROCKETMQ_PUO_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "pro-use-saas-aws-eks-novo",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "pro-use-saas-aws-eks-novo"
    }
  },
  "pro-za-saas-aws-eks-novo": {
    "envLabel": "pro-za-saas-aws-eks-novo",
    "greptimedb": {
      "endpoint": "https://greptimedb.za.novoone.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_PZO_USERNAME",
      "passwordRef": "GREPTIMEDB_PZO_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.za.novoone.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_PZO_USERNAME",
      "passwordRef": "GRAFANA_PZO_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.za.novoone.com",
      "passwordRef": "DBX_PZO_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.za.novoone.com",
      "usernameRef": "ROCKETMQ_PZO_USERNAME",
      "passwordRef": "ROCKETMQ_PZO_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "pro-za-saas-aws-eks-novo",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "pro-za-saas-aws-eks-novo"
    }
  },
  "pro-de-saas-aws-eks-novo": {
    "envLabel": "pro-de-saas-aws-eks-novo",
    "greptimedb": {
      "endpoint": "https://greptimedb.de.novoone.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_PDO_USERNAME",
      "passwordRef": "GREPTIMEDB_PDO_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.de.novoone.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_PDO_USERNAME",
      "passwordRef": "GRAFANA_PDO_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.de.novoone.com",
      "passwordRef": "DBX_PDO_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.de.novoone.com",
      "usernameRef": "ROCKETMQ_PDO_USERNAME",
      "passwordRef": "ROCKETMQ_PDO_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "pro-de-saas-aws-eks-novo",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "pro-de-saas-aws-eks-novo"
    }
  },
  "pro-sg-saas-aws-eks-novo": {
    "envLabel": "pro-sg-saas-aws-eks-novo",
    "greptimedb": {
      "endpoint": "https://greptimedb.sg.novoone.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_PSO_USERNAME",
      "passwordRef": "GREPTIMEDB_PSO_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.sg.novoone.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_PSO_USERNAME",
      "passwordRef": "GRAFANA_PSO_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.sg.novoone.com",
      "passwordRef": "DBX_PSO_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.sg.novoone.com",
      "usernameRef": "ROCKETMQ_PSO_USERNAME",
      "passwordRef": "ROCKETMQ_PSO_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "pro-sg-saas-aws-eks-novo",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "pro-sg-saas-aws-eks-novo"
    }
  },
  "tst-platform-aws-eks-de-0": {
    "envLabel": "tst-platform-aws-eks-de-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.de-0.pre.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TPDE0_USERNAME",
      "passwordRef": "GREPTIMEDB_TPDE0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.de-0.pre.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TPDE0_USERNAME",
      "passwordRef": "GRAFANA_TPDE0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.de-0.pre.novo-one.com",
      "passwordRef": "DBX_TPDE0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.de-0.pre.novo-one.com",
      "usernameRef": "ROCKETMQ_TPDE0_USERNAME",
      "passwordRef": "ROCKETMQ_TPDE0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-aws-eks-de-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-aws-eks-de-0"
    }
  },
  "tst-platform-aws-eks-us-0": {
    "envLabel": "tst-platform-aws-eks-us-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.us-0.pre.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TPUS0_USERNAME",
      "passwordRef": "GREPTIMEDB_TPUS0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.us-0.pre.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TPUS0_USERNAME",
      "passwordRef": "GRAFANA_TPUS0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.us-0.pre.novo-one.com",
      "passwordRef": "DBX_TPUS0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.us-0.pre.novo-one.com",
      "usernameRef": "ROCKETMQ_TPUS0_USERNAME",
      "passwordRef": "ROCKETMQ_TPUS0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-aws-eks-us-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-aws-eks-us-0"
    }
  },
  "tst-platform-aws-eks-au-0": {
    "envLabel": "tst-platform-aws-eks-au-0",
    "greptimedb": {
      "endpoint": "https://greptimedb.au-0.pre.novo-one.com",
      "database": "public",
      "usernameRef": "GREPTIMEDB_TPAU0_USERNAME",
      "passwordRef": "GREPTIMEDB_TPAU0_PASSWORD"
    },
    "grafana": {
      "endpoint": "https://grafana.au-0.pre.novo-one.com",
      "greptimedbJaegerDatasourceUid": "PCD48328C06B18945",
      "usernameRef": "GRAFANA_TPAU0_USERNAME",
      "passwordRef": "GRAFANA_TPAU0_PASSWORD"
    },
    "prometheus": {
      "datasourceUid": "prometheus"
    },
    "dbx": {
      "endpoint": "https://dbx.au-0.pre.novo-one.com",
      "passwordRef": "DBX_TPAU0_PASSWORD"
    },
    "rocketmq": {
      "endpoint": "https://rocketmq.au-0.pre.novo-one.com",
      "usernameRef": "ROCKETMQ_TPAU0_USERNAME",
      "passwordRef": "ROCKETMQ_TPAU0_PASSWORD"
    },
    "zadig": {
      "endpoint": "https://zadig.yeastardigital.com",
      "project": "novo-one-helm-charts-project",
      "envName": "tst-platform-aws-eks-au-0",
      "tokenRef": "ZADIG_API_TOKEN"
    },
    "kubernetes": {
      "endpoint": "http://192.168.5.126:19080/mcp",
      "context": "tst-platform-aws-eks-au-0"
    }
  }
} as unknown as Matrix
