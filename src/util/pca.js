import { Matrix, EigenvalueDecomposition } from "ml-matrix";

/**
 * PCA via eigendecomposition of the covariance matrix.
 * Returns components sorted by descending variance (eigenvalue).
 * Each component: { value: eigenvalue, vector: [x,y,z], sigma: stddev }
 */
export function PCA(cov) {
  const covMat = new Matrix(cov);
  const eigen = new EigenvalueDecomposition(covMat);
  const values = eigen.realEigenvalues;
  const vectors = eigen.eigenvectorMatrix; // columns = eigenvectors
  // build array, sort descending by eigenvalue
  const components = values.map((val, i) => ({
    variance: val,
    sigma: Math.sqrt(Math.max(0, val)),
    vector: vectors.getColumn(i),
  }));
  components.sort((a, b) => b.variance - a.variance);
  return components;
}
