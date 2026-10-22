# Host supplies a validated, frozen generic inverse-variance analysis.
args <- commandArgs(trailingOnly=TRUE)
if(length(args)!=5) stop('input.csv output_dir method sensitivity publication_bias required')
if(!requireNamespace('metafor',quietly=TRUE)) stop('metafor is not installed; no substitute calculation is used')
data <- read.csv(args[1], stringsAsFactors=FALSE)
out <- args[2]; method <- args[3]
if(!method %in% c('REML','FE')) stop('Unsupported estimation method')
if(nrow(data)<2 || any(!is.finite(data$yi)) || any(!is.finite(data$vi)) || any(data$vi<=0)) stop('At least two finite effects with positive variance required')
if(anyDuplicated(data$studyId)) stop('Dependent effects require a separately specified model')
dir.create(out,recursive=TRUE,showWarnings=FALSE)
fit <- metafor::rma.uni(yi=data$yi,vi=data$vi,method=method,slab=data$studyId)
saveRDS(fit,file.path(out,'model.rds'))
num <- function(x) if(length(x)==1 && is.finite(x)) sprintf('%.15g',x) else 'null'
result <- paste0('{"schemaVersion":1,"method":"',method,'","k":',nrow(data),',"estimate":',num(as.numeric(fit$b)),',"se":',num(fit$se),',"ciLower":',num(fit$ci.lb),',"ciUpper":',num(fit$ci.ub),',"tau2":',num(fit$tau2),',"I2":',num(fit$I2),',"Q":',num(fit$QE),'}')
writeLines(result,file.path(out,'results.json'))
writeLines(capture.output(sessionInfo()),file.path(out,'sessionInfo.txt'))
pdf(file.path(out,'forest.pdf')); metafor::forest(fit); dev.off()
svg(file.path(out,'forest.svg')); metafor::forest(fit); dev.off()
if(args[4]=='true') write.csv(as.data.frame(metafor::leave1out(fit)),file.path(out,'leave-one-out.csv'),row.names=FALSE)
if(args[5]=='true') {
  if(nrow(data)<10) stop('Publication-bias diagnostics require at least 10 independent studies in this worker')
  svg(file.path(out,'funnel.svg')); metafor::funnel(fit); dev.off()
  writeLines(capture.output(metafor::regtest(fit)),file.path(out,'regtest.txt'))
}
