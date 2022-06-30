/* eslint valid-jsdoc: "off" */

'use strict';

/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = appInfo => {
  /**
   * built-in config
   * @type {Egg.EggAppConfig}
   **/
  const config = exports = {};

  // use for cookie sign key, should change to your own and keep security
  config.keys = appInfo.name + '_1656054454761_4975';

  // add your middleware config here
  config.middleware = [];

  // add your user config here
  const userConfig = {
    // myAppName: 'egg',
  };

  config.security = {
    csrf: false,
  };

  config.cors = {
    // 匹配规则  域名+端口  *则为全匹配
    // origin: 'http://localhost:8080',
    origin: '*',

    // 匹配请求方式
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH',
  };

  config.multipart = {
    whitelist: [ '.xlsx' ], // 白名单，把你的文件类型加上，不然会报错
  };

  config.redis = {
    client: {
      port: 6379,
      host: '127.0.0.1',
      password: '',
      db: 0,
    },
  };

  return {
    ...config,
    ...userConfig,
  };
};
