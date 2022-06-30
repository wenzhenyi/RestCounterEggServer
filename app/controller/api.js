/* eslint-disable prefer-promise-reject-errors */
'use strict';

const moment = require('moment');
const path = require('path');
const xlsx = require('node-xlsx');
const fs = require('fs');
const sendToWormhole = require('stream-wormhole');
const { last } = require('lodash');

const Controller = require('egg').Controller;

const LPRData = [
  {
    year: '2020',
    monthLPR: [ 0.0415, 0.0405, 0.0405, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385 ],
  },
  {
    year: '2021',
    monthLPR: [ 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0385, 0.0380 ],
  },
  {
    year: '2022',
    monthLPR: [ 0.037, 0.037, 0.037, 0.037, 0.037 ],
  },
];

const getLPRData = async app => {
  const lprData = await app.redis.get('LPRDATA');
  let parseData = null;
  if (!lprData) {
    await app.redis.set('LPRDATA', JSON.stringify(LPRData));
  } else {
    parseData = JSON.parse(lprData);
  }
  return parseData;
};

function getFormatDate_XLSX(serial) {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  const fractional_day = serial - Math.floor(serial) + 0.0000001;
  let total_seconds = Math.floor(86400 * fractional_day);
  const seconds = total_seconds % 60;
  total_seconds -= seconds;
  const hours = Math.floor(total_seconds / (60 * 60));
  const minutes = Math.floor(total_seconds / 60) % 60;
  const d = new Date(date_info.getFullYear(), date_info.getMonth(), date_info.getDate(), hours, minutes, seconds);
  return d;
}


function keepTwoDecimal(num) {
  let result = parseFloat(num);
  if (isNaN(result)) {
    return num;
  }
  result = Math.round(num * 100) / 100;
  return result;
}

function GetRate(contractRate, startTime, payTime, lprData) {
  // const contractRate = item.合同约定年利率;
  const HasBorrowRate = 0.36; // 2020-8-20日前默认利率为0.36
  const NoHasBorrowRate = 0.24; // 2020-8-20日前默认利率为0.36
  let lastRate = 0;
  
  if (startTime && moment(startTime) >= moment('2020-08-20')) {
    const year = moment(startTime).year();
    const month = moment(startTime).month(); // 0 - 11
    // console.log("year!!!!", startTime, year, month, lprData);
    let lpr = lprData.find(item => item.year === year)?.monthLPR[month];
    // 找不到，获取的是最新的lpr数据
    if (!lpr) {
      const findData = lprData[lprData.length - 1].monthLPR;
      lpr = findData[findData.length - 1];
    }
    lastRate = 4 * lpr;
  } else {
    if (payTime && moment(payTime) > moment('2020-08-20')) {
      lastRate = contractRate > 0 && contractRate < NoHasBorrowRate ? contractRate : NoHasBorrowRate;
    } else {
      lastRate = contractRate > 0 && contractRate < HasBorrowRate ? contractRate : HasBorrowRate;
    }
  }
  console.log("lastRate!!!!", lastRate, contractRate, startTime, payTime);
  return lastRate;
}

const computeFn = async (originToObjData, lprData) => {
  // 解析成借款和存款的
  const DataArr = [];
  originToObjData.forEach(item => {
    const brorowObj = {
      本金: item.本金,
      起算时间: item.起算时间,
      截止时间: item.截止时间,
      合同约定年利率: item.合同约定年利率,
      type: 'borrow',
    };

    const stillObj = {
      还款金额: item.还款金额 || 0,
      还款时间: item.还款时间,
      type: 'still',
    };
    // 有借款还款
    if (moment(item.还款时间) > moment('2020-08-20')) {
      if (Object.keys(item).includes('本金')) {
        DataArr.push({
          ...brorowObj,
          截止时间: '2020-08-20',
          利息: GetRate(item.合同约定年利率, item.起算时间, item.还款时间, lprData),
        });
        DataArr.push({
          ...stillObj,
          还款金额: item.还款金额 || 0,
          还款时间: '2020-08-20',
        });
        DataArr.push({
          ...brorowObj,
          本金: 0,
          起算时间: '2020-08-20',
          截止时间: item.还款时间,
          利息: GetRate(item.合同约定年利率, '2020-08-20', item.还款时间, lprData),
        });
        DataArr.push({
          ...stillObj,
          还款金额: 0,
          还款时间: item.还款时间,
        });
      } else {
        // TODO：横跨8月20，只有还款，没有借款
      }
    } else {
      // 有本金的
      if (Object.keys(item).includes('本金')) {
        DataArr.push({
          ...brorowObj,
          利息: GetRate(item.合同约定年利率, item.起算时间, item.还款时间, lprData),
        });
      }

      if (Object.keys(item).includes('还款金额')) {
        DataArr.push(stillObj);
      }
    }
  });

  // 遍历DataArr，计算利息
  const formatDataArr = [];

  // console.log("originToObjData!!", DataArr);
  // console.log('writeFilePath', DataArr);

  let borrowArr = []; // 暂存借款的
  for (let i = 0; i < DataArr.length; i++) {
    const dataItem = DataArr[i];
    // 1. 保存借款的，等只有还款的时候，再计算利息
    if (dataItem.type === 'borrow') {
      borrowArr.push(dataItem);
      continue;
    }

    if (dataItem.type === 'still') {
      // 获取还款日和借款日天数
      let accrual = 0;
      const dataObj = {
        还款金额: dataItem.还款金额,
        还款时间: dataItem.还款时间,
        本金: 0,
        本次借款: 0,
      };

      // eslint-disable-next-line no-loop-func
      borrowArr.forEach((item, index) => {
        // 相差天数
        const diffTime = moment(dataItem.还款时间).diff(moment(item.起算时间), 'day');
        // console.log('diffTime!!!!', diffTime);

        dataObj.本金 += item.本金;

        dataObj.本次借款 += item.本金;

        const lastItem = last(formatDataArr);
        if (lastItem && lastItem.剩余本金 > 0) {
          dataObj.本金 += lastItem.剩余本金;
        }

        accrual += keepTwoDecimal(diffTime * dataObj.本金 * item.利息 / 360);

        dataObj.起算时间 = item.起算时间;
        dataObj.截止时间 = item.截止时间;
        dataObj.合同约定年利率 = `${item.合同约定年利率}${index === borrowArr.length - 1 ? '' : '/'}`;
        dataObj.利率 = `${item.利息}${index === borrowArr.length - 1 ? '' : '/'}`;
      });

      dataObj.还利息余额 = keepTwoDecimal(dataItem.还款金额 - accrual);
      dataObj.剩余本金 = keepTwoDecimal(dataObj.本金 - dataObj.还利息余额);
      borrowArr = [];

      formatDataArr.push({
        ...dataObj,
        利息: keepTwoDecimal(accrual),
      });
    }
  }

  return {
    originData: originToObjData,
    resultData: formatDataArr,
  };
}

class ApiController extends Controller {
  async getUser() {
    const { ctx } = this;
    ctx.body = 'in user';
  }

  async uploadFile() {
    const { ctx } = this;
    const stream = await ctx.getFileStream();
    console.log('steam', stream);

    // 保存到本地
    const currentTime = moment();
    const fileArray = stream.filename.split('.');
    const writeFileName = `${fileArray[0]}-${currentTime.format(
      'YYYY_MM_DD_HH_mm_ss'
    )}.${fileArray[1]}`;
    const writeFilePath = path.join(__dirname, `${writeFileName}`);

    const saveFileResult = await new Promise((resolve, reject) => {
      const remoteFileStream = fs.createWriteStream(writeFilePath, {
        flags: 'w',
        encoding: 'utf8',
      });
      stream.pipe(remoteFileStream);
      let errFlag;
      remoteFileStream.on('error', () => {
        errFlag = true;
        sendToWormhole(stream);
        remoteFileStream.destroy();
        reject('unsuccess');
      });
      remoteFileStream.on('finish', async () => {
        if (errFlag) return;
        resolve('success');
      });
    });

    // 保存文件失败，返回前端提示
    if (saveFileResult === 'unsuccess') {
      ctx.body = ctx.body = { code: -1, msg: '保存文件失败' };
    }

    console.time('数据解析');
    const originData = await xlsx.parse(writeFilePath)[0].data;
    const originToObjData = [];
    for (let i = 1; i < originData.length; i++) {
      const toObjData = {};
      const colums = originData[i];
      // 获取表头
      for (let j = 0; j < colums.length; j++) {
        const columName = originData[0][j];
        if (!toObjData[columName]) {
          toObjData[columName] = '';
        }

        toObjData[columName] = colums[j];

        if (columName && columName.indexOf('时间') >= 0) {
          toObjData[columName] = moment(getFormatDate_XLSX(colums[j])).format('YYYY-MM-DD');
        }
        toObjData.id = Math.floor(Math.random() * 100000) + 100000;
      }
      originToObjData.push(toObjData);
    }

    const lprData = await getLPRData(this.app);
    const data = await computeFn(originToObjData, lprData)
    // console.log('formatDataArr!!!!!!!', formatDataArr);
    // 解析完
    console.timeEnd('数据解析');

    fs.unlink(writeFilePath, error => {
      if (error) {
        console.log('删除本地上传文件失败', error);
      }
    });

    ctx.body = {
      code: 1,
      data,
    };
  }
  
  async computeData() {
    const { ctx } = this;
    // 重新计算数据
    const bodyData = ctx.request.body;
    console.log("inininin", bodyData);
    ctx.body = {
      code: 1,
      data: {}
    }
  }

  // 获取LPR数据
  async getLPR() {
    const { ctx } = this;
    // 检查是否有，没有则手动添加
    const data = await getLPRData(this.app);
    ctx.body = {
      code: 1,
      data,
    };
  }
}

module.exports = ApiController;
