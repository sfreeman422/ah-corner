export type Listing={id:string;itemId:number;quantity:number;total:number;kind:'auction'|'commodity';timeLeft:string};
export type Snapshot={key:string;at:number;source:'demo'|'blizzard';market:string;listings:Listing[]};
export type Stats={at:number;floor:number;units:number;listings:number;median:number};
export type Settings={bankroll:number;exposure:number;minROI:number;minProfit:number;fee:number;minHistory:number};
export type Trade={id:string;itemId:number;side:'buy'|'sell';quantity:number;total:number;fee:number;at:number;note:string};
export type Alert={key:string;at:number;itemId:number;target:number;cost:number;profit:number;score:number};
export type ScannerChecks={minimumHistory:number;minimumSupport:number;priorFloor75thPercentile:number|null;turnoverIntervals:number;historySufficient:boolean;supportSufficient:boolean|null;targetSupported:boolean|null;removalObserved:boolean|null;replenishmentControlled:boolean|null;fresh:boolean};
export type Opportunity={itemId:number;floor:number;target:number;buyMax:number;quantity:number;purchaseListings:number;cost:number;profit:number;roi:number;breakEvenUnits:number;score:number;historyCount:number;support:number;replenish:number|null;removedUnits:number|null;confidence:'watch'|'candidate';checks:ScannerChecks;tiers:{price:number;units:number;cost:number}[];reasons:string[]};
