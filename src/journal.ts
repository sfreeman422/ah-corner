import type {Trade} from './types.ts';
import {validInt} from './engine.ts';

export function validateTrade(value:unknown):Trade{
 const trade=value as Partial<Trade>;
 if(!trade||typeof trade.id!=='string'||!/^[A-Za-z0-9:_-]{1,120}$/.test(trade.id)||!validInt(trade.itemId)||!validInt(trade.quantity)||!validInt(trade.total)||typeof trade.fee!=='number'||!Number.isSafeInteger(trade.fee)||trade.fee<0||!validInt(trade.at)||trade.at>Date.now()+300_000||!['buy','sell'].includes(trade.side||'')||typeof trade.note!=='string'||trade.note.length>200||(trade.side==='sell'&&trade.fee>trade.total))throw Error('Invalid trade record. Item ID, quantity, totals, and fee must be valid; a sale fee cannot exceed its total.');
 return trade as Trade;
}

// Never evaluate Lua. Only accept our strictly formatted quoted records; ignore all other Lua text.
export function parseJournal(text:string):Trade[]{
 if(text.length>2_000_000)throw Error('Journal too large');
 const matches=text.matchAll(/"(AHC1\|[A-Za-z0-9:_-]+\|(?:buy|sell)\|\d+\|\d+\|\d+\|\d+\|\d+)"/g);
 const output:Trade[]=[];
 for(const match of matches){
  const [,id,side,itemId,quantity,total,fee,seconds]=match[1].split('|');
  output.push(validateTrade({id,side,itemId:+itemId,quantity:+quantity,total:+total,fee:+fee,at:+seconds*1_000,note:'Manual addon journal'}));
 }
 return output;
}
