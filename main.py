from fastapi import FastAPI
from pytrends.request import TrendReq
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import datetime

app = FastAPI()

# CORS فعال‌سازی برای ارتباط با وردپرس
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/get_trends")
def get_trends(keyword: str = "موبایل", timeframe: str = "now 7-d", geo: Optional[str] = "IR"):
    pytrends = TrendReq(hl='fa', tz=270)
    pytrends.build_payload([keyword], cat=0, timeframe=timeframe, geo=geo, gprop='')

    interest = pytrends.interest_over_time()
    if interest.empty:
        return {"error": "نتیجه‌ای یافت نشد."}

    result = {
        "keyword": keyword,
        "trend_data": [],
        "top_hour": None,
        "top_day": None
    }

    # تبدیل به داده قابل خواندن برای وردپرس
    for index, row in interest.iterrows():
        result["trend_data"].append({
            "datetime": index.isoformat(),
            "value": int(row[keyword])
        })

    # استخراج روز و ساعت پربازدید
    by_hour = {}
    by_day = {}

    for point in result["trend_data"]:
        dt = datetime.datetime.fromisoformat(point["datetime"])
        hour = dt.hour
        day = dt.strftime("%A")

        by_hour[hour] = by_hour.get(hour, 0) + point["value"]
        by_day[day] = by_day.get(day, 0) + point["value"]

    result["top_hour"] = max(by_hour, key=by_hour.get)
    result["top_day"] = max(by_day, key=by_day.get)

    return result
