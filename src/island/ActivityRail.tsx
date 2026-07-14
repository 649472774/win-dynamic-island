import type { ReactNode, MouseEvent } from "react";
import { useActivities } from "../store/activities";
import { getActivitySnapshot, selectActivity } from "../store/activities";
import type { IslandState } from "../store/island";

interface ActivityRailProps {
  state: IslandState;
  children?: ReactNode;
  expanded?: boolean;
}

export default function ActivityRail({
  state,
  children,
  expanded = false,
}: ActivityRailProps) {
  useActivities((store) => store.revision);
  const snapshot = getActivitySnapshot();
  const activities = snapshot.activities.filter(
    (activity) => activity.channel === "ongoing",
  );
  const selected = snapshot.base;

  const select = (event: MouseEvent, id: string) => {
    event.stopPropagation();
    selectActivity(id);
  };

  if (expanded) {
    if (!activities.length) return null;
    return (
      <div className="activity-rail-expanded" onClick={(event) => event.stopPropagation()}>
        <span className="activity-rail-label">活动</span>
        <div className="activity-rail-items">
          {activities.map((activity) => (
            <button
              key={activity.id}
              className={`activity-rail-item${activity.id === selected?.id ? " active" : ""}`}
              onClick={(event) => select(event, activity.id)}
              title={`切换到${activity.title}`}
              aria-label={`切换到${activity.title}`}
            >
              <span aria-hidden="true">{activity.icon}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (!children) return null;
  const limit = state === "hover" ? 4 : 3;
  const visible = activities.slice(0, limit);
  if (
    selected?.channel === "ongoing" &&
    !visible.some((activity) => activity.id === selected.id)
  ) {
    visible.splice(Math.max(0, limit - 1), 1, selected);
  }
  const hidden = Math.max(0, activities.length - visible.length);

  return (
    <div className={`activity-compact activity-compact-${state}`}>
      <div className="activity-compact-main">{children}</div>
      {activities.length > 1 ? (
        <div className="activity-rail-items compact" onClick={(event) => event.stopPropagation()}>
          {visible.map((activity) => (
            <button
              key={activity.id}
              className={`activity-rail-item${activity.id === selected?.id ? " active" : ""}`}
              onClick={(event) => select(event, activity.id)}
              title={`切换到${activity.title}`}
              aria-label={`切换到${activity.title}`}
            >
              <span aria-hidden="true">{activity.icon}</span>
            </button>
          ))}
          {hidden > 0 ? <span className="activity-rail-more">+{hidden}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
