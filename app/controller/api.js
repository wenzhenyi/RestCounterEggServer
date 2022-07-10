/* eslint-disable prefer-promise-reject-errors */
'use strict';

const moment = require('moment');
const path = require('path');
const xlsx = require('node-xlsx');
const fs = require('fs');
const sendToWormhole = require('stream-wormhole');
const { last, sumBy, isNil, findLastIndex, isEmpty, cloneDeep } = require('lodash');

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

function GetRate(contractRate, startTime, payTime, lprOriginData, realPayTime) {
  // const contractRate = item.合同约定年利率;
  const HasBorrowRate = 0.36; // 2020-8-20日前默认利率为0.36
  const NoHasBorrowRate = 0.24; // 2020-8-20日前默认利率为0.24
  let lastRate = 0;

  let rateMessage = ''

  if (startTime && moment(startTime) >= moment('2020-08-20')) {
    const year = moment(startTime).year();
    const month = moment(startTime).month(); // 0 - 11
    // console.log("year!!!!", startTime, year, month, lprData);
    // LPRData排序
    const lprData = lprOriginData.sort((a, b) => a.year - b.year)
    let lpr = lprData.find(item => item.year == year)?.monthLPR[month];
    console.log("lpr!!!!!!", year, month, lpr)
    rateMessage = `使用${year}年${month + 1}月的LPR：${(lpr * 100).toFixed(2)}%`
    // 找不到，获取的是最新的lpr数据
    if (!lpr) {
      const findData = lprData[lprData.length - 1].monthLPR;
      lpr = findData[findData.length - 1];
      rateMessage = `使用${lprData[lprData.length - 1].year}年${findData.length}月的LPR：${(lpr * 100).toFixed(2)}%`
    }
    lastRate = 4 * lpr;
    
  } else {
    console.log("realPayTime!!!!!!", realPayTime)
    if (realPayTime && moment(realPayTime) >= moment('2020-08-20')) {
      console.log("in~~~~~~", contractRate, NoHasBorrowRate)
      if (contractRate && contractRate <= NoHasBorrowRate) {
        lastRate = contractRate
        rateMessage = `使用的是合同约定的利率${(lastRate * 100).toFixed(2)}%`
      } else {
        lastRate = NoHasBorrowRate
        rateMessage = `使用2020-8-20日前未还的默认利率${(lastRate * 100).toFixed(2)}%`
      }
      // lastRate = contractRate > 0 && contractRate < NoHasBorrowRate ? contractRate : NoHasBorrowRate;
    } else {
      if (contractRate && contractRate <= HasBorrowRate) {
        lastRate = contractRate
        rateMessage = `使用的是合同约定的利率${(lastRate * 100).toFixed(2)}%`
      } else {
        lastRate = HasBorrowRate
        rateMessage = `使用2020-8-20日前已还的默认利率${(lastRate * 100).toFixed(2)}%`
      }
      // lastRate = contractRate > 0 && contractRate < HasBorrowRate ? contractRate : HasBorrowRate;
    }
  }
  // console.log("lastRate!!!!", lastRate, contractRate, startTime, payTime);
  return {
    rate: lastRate,
    rateMessage
  };
}

const computeFn = async (originObjData, lprData) => {
  try {
  const originToObjData = cloneDeep(originObjData)
  console.log("originToObjData!!!!!!!", originToObjData)
  // 解析成借款和存款的
  let DataArr = [];
  originToObjData.forEach(item => {
    // 处理字符串的合同年利率
    if (typeof item.合同约定年利率 === 'string' && item.合同约定年利率.indexOf('%') > 0) {
      item.合同约定年利率 = parseFloat(item.合同约定年利率) / 100
    }

    const brorowObj = {
      本金: item.本金 * 1,
      起算时间: item.起算时间,
      截止时间: item.截止时间,
      合同约定年利率: item.合同约定年利率,
      type: 'borrow',
    };

    const stillObj = {
      还款金额: item.还款金额 * 1 || 0,
      还款时间: item.还款时间,
      type: 'still',
    };

    // 若没有起算时间的，则取前一个还款后的最新的一条起算时间
    if (!item.起算时间) {
      // 找前一个还款
      let borrowIdx = 0
      const findBorrow = findLastIndex(DataArr, item => item.type === 'still')
      if (findBorrow > 0) {
        borrowIdx = findBorrow + 1
      }
      if(DataArr[borrowIdx] && DataArr[borrowIdx].type === 'borrow') {
        item.起算时间 = DataArr[borrowIdx].起算时间
        stillObj.noStartTime = true
      }
    }

    const findStill = findLastIndex(DataArr, item => item.type === 'still')
    // console.log("findStill~~~~~~~~", findStill)
    if (findStill > 0 && moment(DataArr[findStill].还款时间) > moment(item.起算时间)) {
      item.起算时间 = DataArr[findStill].还款时间
    }

    // 有还款的需要给前面没有利率的加上
    if (item.还款时间) {
      DataArr = DataArr.map((dataItem) => {
        const obj = dataItem
        if (dataItem.type === 'borrow' && !dataItem.利率) {
          const rateInfo = GetRate(dataItem.合同约定年利率, dataItem.起算时间, dataItem.还款时间, lprData, item.还款时间)
          obj.利率 = rateInfo.rate
          obj.利率信息 = rateInfo.rateMessage
        }
        return obj
      })
    }

    // 有借款还款
    if (item.起算时间 && item.还款时间 && moment(item.起算时间) < moment('2020-08-20') && moment(item.还款时间) > moment('2020-08-20')) {
      // if (Object.keys(item).includes('本金')) {
        const beforeRate = GetRate(item.合同约定年利率, item.起算时间, '2020-08-20', lprData, item.还款时间);
        const afterRate = GetRate(item.合同约定年利率, '2020-08-20', item.还款时间, lprData, item.还款时间);
        // 若当前没有起算时间的，需要拿上一笔还款后第一笔欠款的时间，且第一笔不需要欠款
        if (!stillObj.noStartTime) {
          DataArr.push({
            ...brorowObj,
            起算时间: item.起算时间,
            截止时间: '2020-08-20',
            利率: beforeRate.rate,
            利率信息: beforeRate.rateMessage
          });
        }
        
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
          利率: afterRate.rate,
          利率信息: afterRate.rateMessage
        });
        DataArr.push({
          ...stillObj,
          还款金额: 0,
          还款时间: item.还款时间,
        });
      // } else {
      //   // TODO：横跨8月20，只有还款，没有借款
      // }
    } else {
      // 有本金的
      if (Object.keys(item).includes('本金') && !isNil(item.本金)) {
        if (item.还款时间) {
          const rateInfo = GetRate(item.合同约定年利率, item.起算时间, item.还款时间, lprData, item.还款时间)
          DataArr.push({
            ...brorowObj,
            起算时间: item.起算时间,
            利率: rateInfo.rate,
            利率信息: rateInfo.rateMessage
          });
        } else {
          DataArr.push({
            ...brorowObj,
            起算时间: item.起算时间,
          });
        }
      }

      if (Object.keys(item).includes('还款金额') && !isNil(item.还款金额)) {
        DataArr.push(stillObj);
      }
    }
  });

  // 查看解析后的是否有还款，没有则提示
  const hasBrrow = DataArr.some((item) => item.type === 'borrow')
  if (!hasBrrow) throw '检测到没有欠款，请输入欠款信息！'

  const hasStill = DataArr.some((item) => item.type === 'still')
  if (!hasStill) throw '检测到没有还款，请输入还款信息！'

  // 遍历DataArr，计算利息
  const formatDataArr = [];

  console.log("DataArr!!!!!", DataArr);
  // console.log('writeFilePath', DataArr);

  // TODO 对借款进行按时间排序
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
      let accrual = 0; // 利息
      let accrualMessage = '完整计算：<br/>'
      const dataObj = {
        还款金额: dataItem.还款金额,
        还款时间: dataItem.还款时间,
        本金: 0,
        本次借款: 0,
        利率: '',
        利率信息: '',
        起算时间: '',
        利息信息: accrualMessage,
      };

      // eslint-disable-next-line no-loop-func
      if (DataArr[i - 1] && DataArr[i - 1].type === 'still' && borrowArr.length === 0) {
        const rateInfo = GetRate(0, DataArr[i - 1].还款时间, dataItem.还款时间, lprData, dataItem.还款时间)
        borrowArr.push({
          本金: 0,
          起算时间: DataArr[i - 1].还款时间,
          截止时间: '-',
          利率: rateInfo.rate,
          利率信息: rateInfo.rateMessage
        })
      }
      borrowArr.forEach((item, index) => {
        // 相差天数
        const diffTime = moment(dataItem.还款时间).diff(moment(item.起算时间), 'day');
        // console.log('diffTime!!!!', diffTime);

        dataObj.本金 += item.本金;

        dataObj.本次借款 += item.本金;

        let nowMoney = item.本金

        const lastItem = last(formatDataArr);
        if (lastItem && lastItem.剩余本金) {
          dataObj.本金 += lastItem.剩余本金;
          nowMoney += lastItem.剩余本金
        }

        const thisAccrual = keepTwoDecimal(diffTime * nowMoney * item.利率 / 360);
        accrual += thisAccrual;

        dataObj.起算时间 += `${item.起算时间}${index === borrowArr.length - 1 ? '' : '/'}`;
        dataObj.截止时间 = item.截止时间;
        dataObj.合同约定年利率 = `${item.合同约定年利率}${index === borrowArr.length - 1 ? '' : '/'}`;
        dataObj.利率 += `${(Number(item.利率) * 100).toFixed(2) + '%'}${index === borrowArr.length - 1 ? '' : '/'}`;
        dataObj.利率信息 += `${item.利率信息}${index === borrowArr.length - 1 ? '' : '/'}`

        dataObj.利息信息 += `本金(${nowMoney}) * 借款天数(${diffTime}) * 利率(${item.利率}) = ${thisAccrual} <br/>`
      });

      dataObj.还利息余额 = keepTwoDecimal(dataItem.还款金额 - accrual);
      dataObj.剩余本金 = keepTwoDecimal(dataObj.本金 - dataObj.还利息余额);

      // 剩余的obj
      borrowArr = [];

      formatDataArr.push({
        ...dataObj,
        利息: keepTwoDecimal(accrual),
      });
    }
  } 

  // 处理原始数据
  const formatOrginData = originObjData.map((item) => {
    if (item.合同约定年利率) item.合同约定年利率 = item.合同约定年利率 * 100
    return item
  })
  
  return {
    originData: formatOrginData,
    resultData: formatDataArr,
    totalBrrow: sumBy(formatDataArr, '本次借款'),
    totalPay: sumBy(formatDataArr, '还款金额'),
    totalRest: last(formatDataArr)?.剩余本金
  };
} catch(err) {
  // console.log("err!!!!!!!", err)
  return {
    code: -1,
    message: err
  }
}
}

class ApiController extends Controller {
  async getUser() {
    const { ctx } = this;
    ctx.body = 'in user';
  }

  async downloadTemplate() {
    const filePath = path.resolve(__dirname, 'template.xlsx');
    this.ctx.attachment('利息计算模板文件.xlsx');
    this.ctx.set('Content-Type', 'application/octet-stream');
    this.ctx.body = fs.createReadStream(filePath);
  }

  async uploadFile() {
      const { ctx } = this;
      const stream = await ctx.getFileStream();
      // console.log('steam', stream);

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
        return ctx.body = { code: -1, msg: '保存文件失败' };
      }

      try {
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

            if (columName && colums[j] && columName.indexOf('时间') >= 0) {
              toObjData[columName] = moment(getFormatDate_XLSX(colums[j])).format('YYYY-MM-DD');
            }

            toObjData.id = Math.floor(Math.random() * 100000) + 100000;
          }
          if (!isEmpty(toObjData)) {
            originToObjData.push(toObjData);
          }
        }

        const lprData = await getLPRData(this.app);
        console.timeEnd('数据解析');

        const data = await computeFn(originToObjData, lprData)
        // console.log('解析完data!!!!!!!', data);
        if (data && data.code === -1) {
          return ctx.body = data
        }
        // 解析完
        return ctx.body = {
          code: 1,
          data,
        };
      } catch(e) {
        return ctx.body = {code: -1, msg: '文件解析失败'};
      } finally {
        // 若报错了，有文件了还是得删除
        fs.unlink(writeFilePath, error => {
          if (error) {
            console.log('删除本地上传文件失败', error);
          }
        });
      }
  }
  
  async computeData() {
    const { ctx } = this;
    // 重新计算数据
    const bodyData = ctx.request.body;
    const lprData = await getLPRData(this.app);
    const formatBodyData = bodyData.map((item) => {
      if (item.合同约定年利率) item.合同约定年利率 = item.合同约定年利率 / 100
      return item
    })
    // console.log("inininin", bodyData);
    const computedData = await computeFn(formatBodyData, lprData)
    if (computedData && computedData.code === -1) {
      return ctx.body = data
    }
    return ctx.body = {
      code: 1,
      data: computedData
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

  // 新增/更新LPR数据
  async uploadLPR() {
    const { ctx, app } = this;
    // 检查是否有，没有则手动添加
    const data = await getLPRData(this.app);
    const { year, month, lpr } = ctx.request.body;
    const setLPR = Math.ceil((lpr / 100) * 10000) / 10000
    const hasYear = data.find((item) => item.year == year)
    // 先判断年份是否存在
    if (!hasYear) {
      // 新增
      data.push({
        year,
        monthLPR: []
      })
    }

    // 更新
    const updateItemIdx = data.findIndex((item) => item.year == year)
    data[updateItemIdx].monthLPR[month * 1] = setLPR
    console.log("data", data, month, setLPR, updateItemIdx)
    await app.redis.set('LPRDATA', JSON.stringify(data));
    // 更新
    ctx.body = {
      code: 1,
      data,
    };
  }
}

module.exports = ApiController;
