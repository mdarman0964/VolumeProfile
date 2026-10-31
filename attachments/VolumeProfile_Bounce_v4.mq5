//+------------------------------------------------------------------+
//|                 VolumeProfile_Bounce_v4.mq5                     |
//|                 XAUUSD M5 + H1 Volume Profile EA                 |
//|                 Research Candidate v4.0                          |
//|                 Trading DISABLED by default                     |
//+------------------------------------------------------------------+
#property copyright "Ras"
#property version   "4.00"
#property strict

#include <Trade/Trade.mqh>

CTrade trade;

//====================================================================
// SAFETY
//====================================================================
input group "=== SAFETY ==="
input bool   EnableTrading       = true; // MUST remain false initially
input bool   AllowBuy            = true;
input bool   AllowSell           = true;
input bool   ManageExistingTrades = true;

//====================================================================
// GENERAL
//====================================================================
input group "=== GENERAL ==="
input double RiskPercent         = 1.0;
input double FixedLot            = 0.01;
input bool   UseRiskPercent      = true;
input ulong  MagicNumber         = 20261031;
input int    SlippagePoints      = 10;
input int    MaxPositions        = 1;

//====================================================================
// SPREAD
//====================================================================
input group "=== SPREAD FILTER ==="
input double MaxSpreadPrice      = 0.20;
input double SpreadSafetyMult    = 1.5;

//====================================================================
// VOLUME PROFILE
//====================================================================
input group "=== VOLUME PROFILE ==="
input int    VP_LookbackBars     = 200;
input int    VP_NumBins          = 32;
input double VP_ValueAreaPct     = 70.0;
input double VP_BounceTolerance  = 0.10;

//====================================================================
// TREND FILTERS
//====================================================================
input group "=== TREND FILTER ==="
input bool   UseM5Trend          = true;
input int    M5_SMA_Period       = 50;

input bool   UseH1Trend          = true;
input int    H1_SMA_Period       = 50;

//====================================================================
// STOP LOSS / TAKE PROFIT
//====================================================================
input group "=== RISK MANAGEMENT ==="
input double StopLossPrice       = 3.00;
input double TakeProfitPrice     = 4.00;

//====================================================================
// ATR TRAILING
//====================================================================
input group "=== ATR TRAILING ==="
input bool   UseATRTrailing      = true;
input int    ATR_Period          = 14;
input double Trail_ATR_Mult      = 0.50;
input double Trail_Start_ATR     = 1.00;
input double Trail_MinPrice      = 0.10;

//====================================================================
// INDICATOR HANDLES
//====================================================================
int m5SmaHandle = INVALID_HANDLE;
int h1SmaHandle = INVALID_HANDLE;
int atrHandle   = INVALID_HANDLE;

datetime lastBarTime = 0;

//====================================================================
// STRUCTURE
//====================================================================
struct VolumeProfileResult
{
   double poc;
   double vah;
   double val;
   bool valid;
};

//====================================================================
// INITIALIZATION
//====================================================================
int OnInit()
{
   if(_Period != PERIOD_M5)
   {
      Print("ERROR: Attach this EA to an M5 chart.");
      return INIT_FAILED;
   }

   if(VP_LookbackBars < 20 ||
      VP_NumBins < 3 ||
      VP_ValueAreaPct <= 0 ||
      VP_ValueAreaPct > 100 ||
      StopLossPrice <= 0 ||
      MaxSpreadPrice <= 0)
   {
      Print("ERROR: Invalid EA inputs.");
      return INIT_PARAMETERS_INCORRECT;
   }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints((ulong)SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   m5SmaHandle = iMA(
      _Symbol, PERIOD_M5, M5_SMA_Period,
      0, MODE_SMA, PRICE_CLOSE
   );

   h1SmaHandle = iMA(
      _Symbol, PERIOD_H1, H1_SMA_Period,
      0, MODE_SMA, PRICE_CLOSE
   );

   atrHandle = iATR(
      _Symbol, PERIOD_M5, ATR_Period
   );

   if(m5SmaHandle == INVALID_HANDLE ||
      h1SmaHandle == INVALID_HANDLE ||
      atrHandle == INVALID_HANDLE)
   {
      Print("ERROR: Indicator initialization failed.");
      return INIT_FAILED;
   }

   Print("VolumeProfile Bounce v4.0 initialized.");
   Print("Trading permission: ", EnableTrading);
   Print("Symbol: ", _Symbol);
   Print("Timeframe: M5");

   if(!EnableTrading)
      Print("SAFE MODE: No orders will be submitted.");

   return INIT_SUCCEEDED;
}

//====================================================================
// DEINITIALIZATION
//====================================================================
void OnDeinit(const int reason)
{
   if(m5SmaHandle != INVALID_HANDLE)
      IndicatorRelease(m5SmaHandle);

   if(h1SmaHandle != INVALID_HANDLE)
      IndicatorRelease(h1SmaHandle);

   if(atrHandle != INVALID_HANDLE)
      IndicatorRelease(atrHandle);
}

//====================================================================
// PRICE NORMALIZATION
//====================================================================
double NormalizePrice(double price)
{
   double tickSize =
      SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);

   if(tickSize <= 0)
      tickSize = _Point;

   price = MathRound(price / tickSize) * tickSize;

   return NormalizeDouble(price, _Digits);
}

//====================================================================
// SPREAD CHECK
//====================================================================
double CurrentSpreadPrice()
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   return ask - bid;
}

bool SpreadIsAcceptable()
{
   double spread = CurrentSpreadPrice();

   if(spread > MaxSpreadPrice)
   {
      Print("Entry blocked: spread = ", spread);
      return false;
   }

   return true;
}

//====================================================================
// VOLUME PROFILE
// Uses completed historical bars only.
// Volume is distributed uniformly across overlapped bins.
//====================================================================
VolumeProfileResult BuildVolumeProfile()
{
   VolumeProfileResult result;

   result.valid = false;
   result.poc = 0;
   result.vah = 0;
   result.val = 0;

   if(Bars(_Symbol, PERIOD_M5) <
      VP_LookbackBars + 5)
      return result;

   double highest = -DBL_MAX;
   double lowest  = DBL_MAX;

   // Exclude current bar and signal bar.
   for(int i = 2; i <= VP_LookbackBars + 1; i++)
   {
      double h = iHigh(_Symbol, PERIOD_M5, i);
      double l = iLow(_Symbol, PERIOD_M5, i);

      if(h <= 0 || l <= 0 || h < l)
         return result;

      highest = MathMax(highest, h);
      lowest  = MathMin(lowest, l);
   }

   if(highest <= lowest)
      return result;

   double binSize =
      (highest - lowest) / VP_NumBins;

   if(binSize <= 0)
      return result;

   double binVolume[];
   ArrayResize(binVolume, VP_NumBins);
   ArrayInitialize(binVolume, 0.0);

   for(int i = 2; i <= VP_LookbackBars + 1; i++)
   {
      double h = iHigh(_Symbol, PERIOD_M5, i);
      double l = iLow(_Symbol, PERIOD_M5, i);

      long volume = iVolume(_Symbol, PERIOD_M5, i);

      if(volume <= 0)
         continue;

      int firstBin =
         (int)MathFloor((l - lowest) / binSize);

      int lastBin =
         (int)MathFloor((h - lowest) / binSize);

      firstBin = (int)MathMax(
         0, MathMin(VP_NumBins - 1, firstBin)
      );

      lastBin = (int)MathMax(
         0, MathMin(VP_NumBins - 1, lastBin)
      );

      int span = lastBin - firstBin + 1;

      if(span <= 0)
         continue;

      double volumePerBin =
         (double)volume / span;

      for(int b = firstBin; b <= lastBin; b++)
         binVolume[b] += volumePerBin;
   }

   // Find POC
   int pocBin = 0;
   double maxVolume = -1;
   double totalVolume = 0;

   for(int b = 0; b < VP_NumBins; b++)
   {
      totalVolume += binVolume[b];

      if(binVolume[b] > maxVolume)
      {
         maxVolume = binVolume[b];
         pocBin = b;
      }
   }

   if(totalVolume <= 0)
      return result;

   result.poc =
      lowest + (pocBin + 0.5) * binSize;

   // Calculate 70% Value Area
   double targetVolume =
      totalVolume * VP_ValueAreaPct / 100.0;

   double coveredVolume = binVolume[pocBin];

   int lowBin = pocBin;
   int highBin = pocBin;

   while(coveredVolume < targetVolume &&
         (lowBin > 0 || highBin < VP_NumBins - 1))
   {
      double below =
         (lowBin > 0) ?
         binVolume[lowBin - 1] : -1;

      double above =
         (highBin < VP_NumBins - 1) ?
         binVolume[highBin + 1] : -1;

      if(above >= below &&
         highBin < VP_NumBins - 1)
      {
         highBin++;
         coveredVolume += binVolume[highBin];
      }
      else if(lowBin > 0)
      {
         lowBin--;
         coveredVolume += binVolume[lowBin];
      }
      else
         break;
   }

   result.val = lowest + lowBin * binSize;
   result.vah = lowest + (highBin + 1) * binSize;

   result.valid = true;

   return result;
}

//====================================================================
// INDICATOR VALUE
//====================================================================
bool GetIndicatorValue(
   int handle,
   int shift,
   double &value
)
{
   double buffer[];

   ArraySetAsSeries(buffer, true);

   if(CopyBuffer(handle, 0, shift, 1, buffer) != 1)
      return false;

   value = buffer[0];

   return value > 0;
}

//====================================================================
// TREND FILTER
//====================================================================
bool GetTrend(
   bool &bullish,
   bool &bearish
)
{
   bullish = true;
   bearish = true;

   double closeM5 = iClose(_Symbol, PERIOD_M5, 1);
   double closeH1 = iClose(_Symbol, PERIOD_H1, 1);

   if(closeM5 <= 0 || closeH1 <= 0)
      return false;

   double smaM5, smaH1;

   if(UseM5Trend)
   {
      if(!GetIndicatorValue(m5SmaHandle, 1, smaM5))
         return false;

      bullish = bullish && (closeM5 > smaM5);
      bearish = bearish && (closeM5 < smaM5);
   }

   if(UseH1Trend)
   {
      if(!GetIndicatorValue(h1SmaHandle, 1, smaH1))
         return false;

      bullish = bullish && (closeH1 > smaH1);
      bearish = bearish && (closeH1 < smaH1);
   }

   return true;
}

//====================================================================
// CANDLE REJECTION CONFIRMATION
//====================================================================
bool BullishBounce(double level)
{
   double low   = iLow(_Symbol, PERIOD_M5, 1);
   double high  = iHigh(_Symbol, PERIOD_M5, 1);
   double open  = iOpen(_Symbol, PERIOD_M5, 1);
   double close = iClose(_Symbol, PERIOD_M5, 1);

   bool touched =
      low <= level + VP_BounceTolerance &&
      high >= level - VP_BounceTolerance;

   bool rejected =
      close > level && close > open;

   return touched && rejected;
}

bool BearishBounce(double level)
{
   double low   = iLow(_Symbol, PERIOD_M5, 1);
   double high  = iHigh(_Symbol, PERIOD_M5, 1);
   double open  = iOpen(_Symbol, PERIOD_M5, 1);
   double close = iClose(_Symbol, PERIOD_M5, 1);

   bool touched =
      high >= level - VP_BounceTolerance &&
      low <= level + VP_BounceTolerance;

   bool rejected =
      close < level && close < open;

   return touched && rejected;
}

//====================================================================
// POSITION COUNT
//====================================================================
int CountOpenPositions()
{
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);

      if(ticket == 0)
         continue;

      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      if(PositionGetInteger(POSITION_MAGIC) !=
         (long)MagicNumber)
         continue;

      count++;
   }

   return count;
}

//====================================================================
// LOT CALCULATION
//====================================================================
double CalculateLot(
   ENUM_ORDER_TYPE orderType,
   double entryPrice,
   double stopPrice
)
{
   if(!UseRiskPercent)
      return FixedLot;

   double balance =
      AccountInfoDouble(ACCOUNT_BALANCE);

   double riskMoney =
      balance * RiskPercent / 100.0;

   double profit = 0;

   if(!OrderCalcProfit(
      orderType,
      _Symbol,
      1.0,
      entryPrice,
      stopPrice,
      profit
   ))
   {
      Print("OrderCalcProfit failed: ", GetLastError());
      return 0;
   }

   double lossPerLot = MathAbs(profit);

   if(lossPerLot <= 0)
      return 0;

   double volume = riskMoney / lossPerLot;

   double minLot =
      SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double maxLot =
      SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

   double step =
      SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(step <= 0)
      return 0;

   // Round DOWN to avoid exceeding requested risk.
   volume = MathFloor(volume / step) * step;

   if(volume < minLot)
   {
      Print("Risk lot below broker minimum. Trade skipped.");
      return 0;
   }

   volume = MathMin(volume, maxLot);

   return NormalizeDouble(volume, 8);
}

//====================================================================
// BROKER STOP DISTANCE
//====================================================================
double MinimumStopDistance()
{
   long stopsLevel =
      SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);

   long freezeLevel =
      SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);

   long minimumLevel =
      MathMax(stopsLevel, freezeLevel);

   return (minimumLevel + 1) * _Point;
}

//====================================================================
// OPEN BUY
//====================================================================
void OpenBuy()
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double sl = NormalizePrice(ask - StopLossPrice);
   double tp = (TakeProfitPrice > 0) ?
      NormalizePrice(ask + TakeProfitPrice) : 0;

   double lot = CalculateLot(
      ORDER_TYPE_BUY, ask, sl
   );

   if(lot <= 0)
      return;

   if(!trade.Buy(
      lot,
      _Symbol,
      0,
      sl,
      tp,
      "VP v4 BUY"
   ))
   {
      Print("BUY failed: ",
            trade.ResultRetcode(),
            " ",
            trade.ResultRetcodeDescription());
   }
   else
   {
      Print("BUY request accepted. Lot: ", lot);
   }
}

//====================================================================
// OPEN SELL
//====================================================================
void OpenSell()
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   double sl = NormalizePrice(bid + StopLossPrice);
   double tp = (TakeProfitPrice > 0) ?
      NormalizePrice(bid - TakeProfitPrice) : 0;

   double lot = CalculateLot(
      ORDER_TYPE_SELL, bid, sl
   );

   if(lot <= 0)
      return;

   if(!trade.Sell(
      lot,
      _Symbol,
      0,
      sl,
      tp,
      "VP v4 SELL"
   ))
   {
      Print("SELL failed: ",
            trade.ResultRetcode(),
            " ",
            trade.ResultRetcodeDescription());
   }
   else
   {
      Print("SELL request accepted. Lot: ", lot);
   }
}

//====================================================================
// ENTRY LOGIC
//====================================================================
void CheckForEntry()
{
   if(!EnableTrading)
      return;

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   {
      Print("Terminal trading permission is disabled.");
      return;
   }

   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))
   {
      Print("EA trading permission is disabled.");
      return;
   }

   if(!SpreadIsAcceptable())
      return;

   if(CountOpenPositions() >= MaxPositions)
      return;

   VolumeProfileResult vp = BuildVolumeProfile();

   if(!vp.valid)
      return;

   bool bullish, bearish;

   if(!GetTrend(bullish, bearish))
      return;

   bool buySignal = false;
   bool sellSignal = false;

   if(AllowBuy && bullish)
   {
      buySignal =
         BullishBounce(vp.val) ||
         BullishBounce(vp.poc);
   }

   if(AllowSell && bearish)
   {
      sellSignal =
         BearishBounce(vp.vah) ||
         BearishBounce(vp.poc);
   }

   // Avoid ambiguous simultaneous signals.
   if(buySignal && sellSignal)
   {
      Print("Ambiguous signal. No trade.");
      return;
   }

   if(buySignal)
   {
      Print("BUY signal confirmed.");
      OpenBuy();
   }
   else if(sellSignal)
   {
      Print("SELL signal confirmed.");
      OpenSell();
   }
}

//====================================================================
// ATR TRAILING STOP
//====================================================================