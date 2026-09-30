import { arxiUserCopy } from "../../shared/arxi-user-copy.js";

const SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT = arxiUserCopy(
  "The selected auth profile is unavailable in this agent's OpenClaw credential store. " +
    "Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.",
  "Подключение к ChatGPT недоступно. Подключи подписку заново в настройках.",
);
export const renderFailoverCodeUserCopy = (code: unknown): string | undefined =>
  code === "needs_expansion"
    ? arxiUserCopy(
        "The personal context budget cannot safely fit this continuation (needs_expansion). I stopped before sending more context, preserving the required owner rules. A larger-context continuation is needed.",
        "Не хватает места для личного контекста. Остановила продолжение, сохранив важные правила. Чтобы закончить запрос, нужен ход с расширенным контекстом.",
      )
    : code === "selected_auth_profile_unavailable"
      ? SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT
      : undefined;
