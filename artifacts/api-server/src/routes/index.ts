import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import autoLoginRouter from "./auto-login";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(autoLoginRouter);

export default router;
