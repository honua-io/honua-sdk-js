using System;
using System.Text.Json;
using Honua.Import.FileImport;
foreach (var body in new[] {
 """{"sourceUrl":"https://example.s3.amazonaws.com/fixture.geojson","tableName":"fixture","forceBackground":true}""",
 """{"forceBackground":true,"targetSrid":4326,"overwriteExisting":false,"trackProgress":false,"tableName":"fixture","sourceUrl":"https://example.s3.amazonaws.com/fixture.geojson"}""",
 """{"forceBackground":true,"targetSrid":3857,"overwriteExisting":false,"trackProgress":false,"tableName":"fixture","sourceUrl":"https://example.s3.amazonaws.com/fixture.geojson"}""",
 """{"forceBackground":true,"targetSrid":0,"overwriteExisting":false,"trackProgress":false,"tableName":"fixture","sourceUrl":"https://example.s3.amazonaws.com/fixture.geojson"}"""
}) {
 var value=JsonSerializer.Deserialize(body, ImportJsonContext.Default.ImportUrlImportRequest);
 Console.WriteLine(JsonSerializer.Serialize(value, ImportJsonContext.Default.ImportUrlImportRequest));
}
