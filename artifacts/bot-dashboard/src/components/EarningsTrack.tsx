import { useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, RefreshCw } from "lucide-react";

export interface EarningsPoint {
  ts: number;
  coins: number;
}

interface Props {
  data: EarningsPoint[];
  current: number | null;
  onClear: () => void;
}

function istTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });
}

function istTimeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });
}

interface TooltipProps {
  active?: boolean;
  payload?: { value: number; payload: EarningsPoint }[];
}

function CustomTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-[#111] border border-[#2a2a2a] rounded px-3 py-2 font-mono text-xs shadow-lg">
      <div className="text-[#aaa] mb-1">{istTime(point.ts)}</div>
      <div className="text-emerald-400">
        Earned : <span className="font-bold">{point.coins.toFixed(4)}</span>
      </div>
    </div>
  );
}

interface TickProps {
  x?: number;
  y?: number;
  payload?: { value: number };
  index?: number;
  visibleTicksCount?: number;
}

function CustomXTick({ x, y, payload, index, visibleTicksCount }: TickProps) {
  if (
    payload == null ||
    index == null ||
    visibleTicksCount == null
  )
    return null;
  const total = visibleTicksCount;
  if (total > 12 && index % Math.ceil(total / 12) !== 0) return null;
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="middle"
        fill="#555"
        fontSize={10}
        fontFamily="monospace"
      >
        {istTimeShort(payload.value)}
      </text>
    </g>
  );
}

export default function EarningsTrack({ data, current, onClear }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);

  const displayCurrent =
    current !== null ? current.toFixed(2) : data.length > 0 ? data[data.length - 1].coins.toFixed(2) : "0.00";

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground uppercase tracking-widest">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
          <span>Earnings_Track</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider">
            CURRENT: {displayCurrent}
          </span>
          <button
            onClick={onClear}
            title="Clear history"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {data.length < 2 ? (
        <div className="h-[180px] flex items-center justify-center text-muted-foreground text-xs font-mono opacity-50">
          {data.length === 0
            ? "Waiting for earnings data..."
            : "Collecting data points..."}
        </div>
      ) : (
        <div ref={chartRef} className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 8, left: -20, bottom: 16 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#1e1e1e"
                vertical={true}
              />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tick={(props) => <CustomXTick {...props} />}
                tickLine={false}
                axisLine={{ stroke: "#2a2a2a" }}
              />
              <YAxis
                tick={{ fill: "#555", fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={false}
                width={36}
                tickFormatter={(v: number) => String(Math.round(v))}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="coins"
                stroke="#34d399"
                strokeWidth={2}
                dot={{ fill: "#34d399", r: 3, strokeWidth: 0 }}
                activeDot={{ fill: "#fff", r: 5, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
