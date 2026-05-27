const { Sequelize, DataTypes } = require("sequelize");

const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

let memoryCount = 0;

const MemoryCounter = {
  async create() {
    memoryCount += 1;
  },

  async destroy(options = {}) {
    if (options.truncate) {
      memoryCount = 0;
    }
  },

  async count() {
    return memoryCount;
  },
};

function createMysqlCounter() {
  const [host, port] = MYSQL_ADDRESS.split(":");
  const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
    host,
    port,
    dialect: "mysql",
  });

  const Counter = sequelize.define("Counter", {
    count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  });

  return {
    Counter,
    async init() {
      await Counter.sync({ alter: true });
    },
  };
}

const hasMysqlConfig = MYSQL_USERNAME && MYSQL_PASSWORD && MYSQL_ADDRESS;
const database = hasMysqlConfig
  ? createMysqlCounter()
  : {
      Counter: MemoryCounter,
      async init() {
        console.log("未检测到 MySQL 环境变量，/api/count 使用内存计数");
      },
    };

module.exports = {
  init: database.init,
  Counter: database.Counter,
};
