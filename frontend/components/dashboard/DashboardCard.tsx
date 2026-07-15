import { ReactNode } from "react";
import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";

interface DashboardCardProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  value?: string | number;
  children?: ReactNode;
  delay?: number;
  className?: string;
}

export function DashboardCard({
  title,
  description,
  icon: Icon,
  value,
  children,
  delay = 0,
  className = "",
}: DashboardCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      className={`bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md relative overflow-hidden group ${className}`}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/0 to-purple-500/0 group-hover:from-indigo-500/5 group-hover:to-purple-500/5 transition-colors duration-500" />
      
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {Icon && (
              <div className="p-2 rounded-lg bg-white/5 text-indigo-400">
                <Icon className="w-5 h-5" />
              </div>
            )}
            <div>
              <h3 className="text-white font-medium">{title}</h3>
              {description && <p className="text-sm text-gray-400">{description}</p>}
            </div>
          </div>
          {value !== undefined && (
            <div className="text-2xl font-bold text-white">{value}</div>
          )}
        </div>
        
        {children && <div className="mt-4">{children}</div>}
      </div>
    </motion.div>
  );
}
